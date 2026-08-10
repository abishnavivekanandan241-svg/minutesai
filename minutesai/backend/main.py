import os
import json
import asyncio
import logging
import base64
import io
import re
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from dotenv import load_dotenv
from groq import Groq
import websockets
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
import tempfile
import pytesseract
from PIL import Image

pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("MinutesAI")

app = FastAPI(title="MinutesAI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# NOTE: speaker_name_map is no longer used to bake names into transcript text.
# Names live entirely on the frontend now, resolved at render time, so a name
# detected later applies retroactively to all of that speaker's past lines.
speaker_map = {}

def get_consistent_speaker(raw_speaker):
    if raw_speaker not in speaker_map:
        speaker_map[raw_speaker] = len(speaker_map) + 1
    return speaker_map[raw_speaker]


STRICT_NAME_PATTERN = re.compile(r"^[A-Z][a-zA-Z.'-]+(\s[A-Z][a-zA-Z.'-]+){0,2}$")
# Finds a 2-3 capitalized-word name ANYWHERE inside a noisy line (e.g. a
# stray leading quote mark or trailing OCR artifact around the real name).
EMBEDDED_NAME_PATTERN = re.compile(r"[A-Z][a-zA-Z.'-]{1,20}(?:\s[A-Z][a-zA-Z.'-]{1,20}){1,2}")
# Fallback: mostly-letters line, allows minor OCR noise (stray digit/symbol,
# lowercase leading letter) that the strict pattern would reject outright.
LOOSE_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z .'\-]{1,39}$")

# Lines that are clearly Zoom/YouTube UI chrome, not a person's name —
# skip these even if they happen to pass the loose pattern.
UI_NOISE_WORDS = {
    "search", "subscribe", "share", "download", "save", "youtube",
    "zoom", "stop sharing", "audit", "risk", "committee", "meeting",
    "governance", "strategy", "manager", "finance", "council",
    "district", "regional", "district council",
}

def _is_noise(candidate):
    """True if candidate is (or is essentially just) a blocklisted UI/role
    word — checks contained words, not exact string equality, so stray
    punctuation the OCR tacks on (e.g. 'Governance.') doesn't slip past."""
    cleaned = re.sub(r"[^a-z ]", "", candidate.lower()).strip()
    if cleaned in UI_NOISE_WORDS:
        return True
    words = cleaned.split()
    return bool(words) and all(w in UI_NOISE_WORDS for w in words)

def guess_name_from_ocr_lines(lines):
    """Prefer a line that looks like a person's name. Try strict Title-Case
    matching first; if nothing matches (e.g. OCR output is slightly noisy),
    fall back to a looser mostly-letters match, filtering out obvious UI text."""
    # First: search for a 2-3 capitalized-word name embedded anywhere in
    # each line, ignoring stray junk characters around it (quotes, digits,
    # symbols the OCR sometimes tacks on next to the real label text).
    for line in lines:
        m = EMBEDDED_NAME_PATTERN.search(line)
        if m and not _is_noise(m.group(0)):
            return m.group(0)
    for line in lines:
        candidate = line.strip()
        if 4 <= len(candidate) <= 40 and len(candidate.split()) <= 3 and STRICT_NAME_PATTERN.match(candidate):
            return candidate
    for line in lines:
        candidate = line.strip()
        if (4 <= len(candidate) <= 40
                and len(candidate.split()) <= 3
                and candidate[0].isupper()
                and LOOSE_NAME_PATTERN.match(candidate)
                and not _is_noise(candidate)
                and sum(c.isalpha() for c in candidate) >= len(candidate) * 0.7):
            return candidate
    # Third fallback: Tesseract sometimes merges a two-word name into one
    # all-lowercase token with no space (e.g. "brucerobertson"). Accept a
    # single long lowercase alphabetic word and just capitalize it — not
    # perfect, but far better than showing "Speaker N" indefinitely.
    for line in lines:
        candidate = line.strip()
        if (candidate.isalpha()
                and candidate.islower()
                and 6 <= len(candidate) <= 30
                and not _is_noise(candidate)):
            return candidate.capitalize()
    return None


@app.get("/")
async def root():
    return {"message": "Welcome to MinutesAI API"}


@app.post("/api/detect-speaker-name")
async def detect_speaker_name(request: dict):
    try:
        image_data = request.get("frame", "")
        if not image_data:
            return {"name": None}
        img_bytes = base64.b64decode(image_data.split(",")[1])
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")

        # The crop from a video tile is often small and blurry from video
        # compression — upscale + grayscale + contrast boost before OCR,
        # since Tesseract does much better on larger, higher-contrast text.
        scale = 4
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
        gray = img.convert("L")
        # Simple threshold to push text/background further apart.
        gray = gray.point(lambda p: 0 if p > 140 else 255)

        text = pytesseract.image_to_string(gray, config="--psm 6")
        lines = [l.strip() for l in text.split('\n') if l.strip() and len(l.strip()) > 1]
        detected_name = guess_name_from_ocr_lines(lines)
        logger.info(f"OCR lines: {lines} -> detected: {detected_name}")
        return {"name": detected_name, "all_text": lines}
    except Exception as e:
        logger.error(f"OCR error: {e}")
        return {"name": None, "error": str(e)}


@app.websocket("/ws/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to /ws/transcribe")
    speaker_map.clear()

    deepgram_url = (
        f"wss://api.deepgram.com/v1/listen"
        f"?model=nova-2"
        f"&language=en-US"
        f"&smart_format=true"
        f"&diarize=true"
        f"&punctuate=true"
        f"&interim_results=true"
        f"&encoding=linear16"
        f"&sample_rate=16000"
        f"&channels=1"
    )

    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

    try:
        async with websockets.connect(deepgram_url, additional_headers=headers) as dg_ws:
            logger.info("Connected to Deepgram successfully")
            await websocket.send_text(json.dumps({"type": "status", "message": "connected_to_deepgram"}))

            async def receive_from_client():
                try:
                    while True:
                        message = await websocket.receive()
                        if "bytes" in message:
                            await dg_ws.send(message["bytes"])
                        elif "text" in message:
                            data = json.loads(message["text"])
                            if data.get("type") == "stop":
                                break
                except WebSocketDisconnect:
                    logger.info("Client disconnected")
                except Exception as e:
                    logger.error(f"Error receiving from client: {e}")

            async def receive_from_deepgram():
                try:
                    async for message in dg_ws:
                        data = json.loads(message)
                        if data.get("type") == "Results":
                            is_final = data.get("is_final", False)
                            words = (
                                data.get("channel", {})
                                .get("alternatives", [{}])[0]
                                .get("words", [])
                            )
                            if not words:
                                continue

                            # Build a list of {speaker, text} segments instead of
                            # baking a display name into a single text blob.
                            segments = []
                            current_speaker = None
                            buf = []
                            for word in words:
                                speaker = get_consistent_speaker(word.get("speaker", 0))
                                if speaker != current_speaker:
                                    if buf:
                                        segments.append({
                                            "speaker": current_speaker,
                                            "text": " ".join(buf)
                                        })
                                    buf = []
                                    current_speaker = speaker
                                buf.append(word.get("punctuated_word", word.get("word", "")))
                            if buf:
                                segments.append({
                                    "speaker": current_speaker,
                                    "text": " ".join(buf)
                                })

                            if segments:
                                await websocket.send_text(json.dumps({
                                    "type": "transcript",
                                    "segments": segments,
                                    "is_final": is_final
                                }))
                except Exception as e:
                    logger.error(f"Error receiving from Deepgram: {e}")

            await asyncio.gather(receive_from_client(), receive_from_deepgram())

    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except:
            pass


@app.post("/api/generate-minutes")
async def generate_minutes(request: dict):
    transcript = request.get("transcript", "")
    if not transcript:
        return {"error": "No transcript provided"}
    words = transcript.split()
    if len(words) > 800:
        transcript = " ".join(words[:800])
    client = Groq(api_key=GROQ_API_KEY)
    message = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        max_tokens=4000,
        messages=[{
            "role": "user",
            "content": f"""IMPORTANT: Always respond in ENGLISH only.

Analyze transcript. Detect type:
- instructor explaining = "lecture"
- presenter with Q&A = "webinar"
- team discussion = "meeting"

Return ONLY valid JSON.

If lecture:
{{"type":"lecture","meeting_title":"topic","date":"today","duration":"est","subject":"subject","instructor":"name or Unknown","executive_summary":"4-5 sentences","key_concepts":["c1","c2","c3","c4","c5"],"important_points":["p1","p2","p3","p4","p5"],"definitions":["t1: def","t2: def"],"references":["r1","r2"],"quiz_questions":["q1?","q2?","q3?"]}}

If webinar:
{{"type":"webinar","meeting_title":"title","date":"today","duration":"est","speaker":"name or Unknown","executive_summary":"4-5 sentences","main_takeaways":["t1","t2","t3","t4"],"topics_covered":["t1","t2","t3"],"resources_shared":["r1","r2"],"qa_summary":"summary","action_items":[{{"task":"task","deadline":"TBD","priority":"high/medium/low"}}]}}

If meeting:
{{"type":"meeting","meeting_title":"title","date":"today","duration":"est","attendees":["n1","n2"],"executive_summary":"4-5 sentences","key_decisions":["d1","d2","d3"],"action_items":[{{"task":"task","owner":"person","deadline":"deadline or TBD","priority":"high/medium/low"}}],"topics_discussed":["t1","t2","t3"],"next_meeting":"details or null"}}

Transcript:
{transcript}"""
        }]
    )
    try:
        return json.loads(message.choices[0].message.content)
    except:
        return {"raw": message.choices[0].message.content}


@app.post("/api/export-pdf")
async def export_pdf(request: dict):
    minutes = request.get("minutes", {})
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    doc = SimpleDocTemplate(tmp.name, pagesize=letter, rightMargin=50, leftMargin=50, topMargin=50, bottomMargin=50)
    styles = getSampleStyleSheet()
    story = []
    title_style = ParagraphStyle('T', parent=styles['Heading1'], fontSize=22, textColor=colors.HexColor('#6C63FF'), spaceAfter=6)
    heading_style = ParagraphStyle('H', parent=styles['Heading2'], fontSize=14, textColor=colors.HexColor('#333333'), spaceAfter=8, spaceBefore=12)
    body_style = ParagraphStyle('B', parent=styles['Normal'], fontSize=11, leading=16, spaceAfter=6)
    bullet_style = ParagraphStyle('Bullet', parent=styles['Normal'], fontSize=11, leading=16, leftIndent=20, spaceAfter=4)
    meeting_type = minutes.get("type", "meeting")
    story.append(Paragraph("MinutesAI", title_style))
    story.append(Paragraph(minutes.get("meeting_title", "Minutes"), styles['Heading1']))
    story.append(Paragraph(f"Date: {minutes.get('date','')} | Type: {meeting_type.upper()}", body_style))
    story.append(Spacer(1, 12))
    story.append(Paragraph("Executive Summary", heading_style))
    story.append(Paragraph(minutes.get("executive_summary", ""), body_style))
    story.append(Spacer(1, 8))
    if meeting_type == "lecture":
        if minutes.get("instructor"):
            story.append(Paragraph(f"Instructor: {minutes['instructor']}", body_style))
        if minutes.get("subject"):
            story.append(Paragraph(f"Subject: {minutes['subject']}", body_style))
        for section, label in [("key_concepts","Key Concepts"),("important_points","Important Points"),("definitions","Definitions"),("quiz_questions","Quiz Questions"),("references","References")]:
            if minutes.get(section):
                story.append(Paragraph(label, heading_style))
                for i, item in enumerate(minutes[section], 1):
                    story.append(Paragraph(f"{i}. {item}", bullet_style))
    elif meeting_type == "webinar":
        if minutes.get("speaker"):
            story.append(Paragraph(f"Speaker: {minutes['speaker']}", body_style))
        for section, label in [("main_takeaways","Main Takeaways"),("topics_covered","Topics Covered"),("resources_shared","Resources Shared")]:
            if minutes.get(section):
                story.append(Paragraph(label, heading_style))
                for item in minutes[section]:
                    story.append(Paragraph(f"• {item}", bullet_style))
        if minutes.get("qa_summary"):
            story.append(Paragraph("Q&A Summary", heading_style))
            story.append(Paragraph(minutes["qa_summary"], body_style))
        if minutes.get("action_items"):
            story.append(Paragraph("Action Items", heading_style))
            for item in minutes["action_items"]:
                story.append(Paragraph(f"• {item.get('task','')} | Deadline: {item.get('deadline','TBD')} | Priority: {item.get('priority','')}", bullet_style))
    else:
        if minutes.get("key_decisions"):
            story.append(Paragraph("Key Decisions", heading_style))
            for i, d in enumerate(minutes["key_decisions"], 1):
                story.append(Paragraph(f"{i}. {d}", bullet_style))
        if minutes.get("action_items"):
            story.append(Paragraph("Action Items", heading_style))
            data = [["Task", "Owner", "Deadline", "Priority"]]
            for item in minutes["action_items"]:
                task = item.get("task","")[:40] + "..." if len(item.get("task","")) > 40 else item.get("task","")
                deadline = item.get("deadline","")[:30] + "..." if len(item.get("deadline","")) > 30 else item.get("deadline","")
                owner = item.get("owner","")[:12] + "..." if len(item.get("owner","")) > 12 else item.get("owner","")
                data.append([task, owner, deadline, item.get("priority","")])
            table = Table(data, colWidths=[220, 90, 130, 60])
            table.setStyle([
                ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#6C63FF')),
                ('TEXTCOLOR',(0,0),(-1,0),colors.white),
                ('FONTSIZE',(0,0),(-1,-1),9),
                ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F5F5F5')]),
                ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#DDDDDD')),
                ('PADDING',(0,0),(-1,-1),6),
                ('VALIGN',(0,0),(-1,-1),'TOP'),
                ('WORDWRAP',(0,0),(-1,-1),True),
            ])
            story.append(table)
        if minutes.get("topics_discussed"):
            story.append(Paragraph("Topics Discussed", heading_style))
            for t in minutes["topics_discussed"]:
                story.append(Paragraph(f"• {t}", bullet_style))
        if minutes.get("attendees"):
            story.append(Paragraph("Attendees", heading_style))
            story.append(Paragraph(", ".join(minutes["attendees"]), body_style))
        if minutes.get("next_meeting"):
            story.append(Paragraph("Next Meeting", heading_style))
            story.append(Paragraph(minutes["next_meeting"], body_style))
    doc.build(story)
    return FileResponse(tmp.name, media_type="application/pdf", filename="meeting-minutes.pdf")