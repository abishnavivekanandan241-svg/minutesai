import os
import json
import asyncio
import logging
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

@app.get("/")
async def root():
    return {"message": "Welcome to MinutesAI API"}

@app.websocket("/ws/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to /ws/transcribe")
    
    deepgram_url = (
        f"wss://api.deepgram.com/v1/listen"
        f"?model=nova-2"
        f"&language=en"
        f"&smart_format=true"
        f"&punctuate=true"
        f"&interim_results=true"
        f"&encoding=linear16"
        f"&sample_rate=16000"
        f"&channels=1"
    )
    
    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
    
    try:
        async with websockets.connect(
            deepgram_url,
            additional_headers=headers
        ) as dg_ws:
            logger.info("Connected to Deepgram successfully")
            
            await websocket.send_text(json.dumps({
                "type": "status",
                "message": "connected_to_deepgram"
            }))
            
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
                            transcript = (
                                data.get("channel", {})
                                .get("alternatives", [{}])[0]
                                .get("transcript", "")
                            )
                            if transcript:
                                await websocket.send_text(json.dumps({
                                    "type": "transcript",
                                    "text": transcript,
                                    "is_final": data.get("is_final", False)
                                }))
                except Exception as e:
                    logger.error(f"Error receiving from Deepgram: {e}")
            
            await asyncio.gather(
                receive_from_client(),
                receive_from_deepgram()
            )
            
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": str(e)
            }))
        except:
            pass

@app.post("/api/generate-minutes")
async def generate_minutes(request: dict):
    transcript = request.get("transcript", "")
    
    if not transcript:
        return {"error": "No transcript provided"}
    
    # Truncate to avoid token limit
    words = transcript.split()
    if len(words) > 800:
        transcript = " ".join(words[:800])
    
    client = Groq(api_key=GROQ_API_KEY)
    
    message = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        max_tokens=4000,
        messages=[{
            "role": "user",
            "content": f"""IMPORTANT: The transcript may be in any language or mixed languages (like Tamil+English, Hindi+English). Always generate ALL fields and responses in ENGLISH only, regardless of the transcript language.

You are an expert meeting analyst. Analyze this transcript carefully and extract as much detail as possible. Do NOT give short or incomplete answers. Every list should have at least 3-5 items if the content supports it.

First detect the type, then return ONLY a valid JSON object with no other text.

Detection rules:
- instructor/teacher/professor explaining concepts = "lecture"
- presenter/host with audience Q&A = "webinar"
- team discussion, decisions, tasks = "meeting"

If type is "lecture":
{{
    "type": "lecture",
    "meeting_title": "specific topic of the lecture",
    "date": "today",
    "duration": "estimated duration",
    "subject": "subject or course name",
    "instructor": "instructor name if mentioned else Unknown",
    "key_concepts": ["detailed concept 1", "detailed concept 2", "detailed concept 3", "detailed concept 4", "detailed concept 5"],
    "executive_summary": "Write 4-5 detailed sentences summarizing everything taught in this lecture. Be specific and comprehensive.",
    "important_points": ["detailed point 1", "detailed point 2", "detailed point 3", "detailed point 4", "detailed point 5"],
    "definitions": ["term1: full definition", "term2: full definition", "term3: full definition"],
    "references": ["reference 1", "reference 2"],
    "quiz_questions": ["question 1?", "question 2?", "question 3?", "question 4?", "question 5?"]
}}

If type is "webinar":
{{
    "type": "webinar",
    "meeting_title": "specific webinar title",
    "date": "today",
    "duration": "estimated duration",
    "speaker": "speaker name if mentioned else Unknown",
    "executive_summary": "Write 4-5 detailed sentences summarizing everything covered in this webinar.",
    "main_takeaways": ["detailed takeaway 1", "detailed takeaway 2", "detailed takeaway 3", "detailed takeaway 4", "detailed takeaway 5"],
    "topics_covered": ["topic 1", "topic 2", "topic 3", "topic 4"],
    "resources_shared": ["resource 1", "resource 2"],
    "qa_summary": "Detailed summary of Q&A session if any, else write main questions audience might have",
    "action_items": [
        {{
            "task": "specific action to take",
            "deadline": "TBD",
            "priority": "high or medium or low"
        }}
    ]
}}

If type is "meeting":
{{
    "type": "meeting",
    "meeting_title": "specific meeting title based on content",
    "date": "today",
    "duration": "estimated duration",
    "attendees": ["name1", "name2"],
    "executive_summary": "Write 4-5 detailed sentences summarizing everything discussed and decided in this meeting.",
    "key_decisions": ["specific decision 1", "specific decision 2", "specific decision 3"],
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible",
            "deadline": "mentioned deadline or TBD",
            "priority": "high or medium or low"
        }}
    ],
    "topics_discussed": ["topic 1", "topic 2", "topic 3"],
    "next_meeting": "next meeting details or null"
}}

Transcript:
{transcript}"""
        }]
    )
    
    try:
        minutes = json.loads(message.choices[0].message.content)
        return minutes
    except:
        return {"raw": message.choices[0].message.content}

@app.post("/api/export-pdf")
async def export_pdf(request: dict):
    minutes = request.get("minutes", {})
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    doc = SimpleDocTemplate(tmp.name, pagesize=letter,
                           rightMargin=50, leftMargin=50,
                           topMargin=50, bottomMargin=50)
    styles = getSampleStyleSheet()
    story = []

    title_style = ParagraphStyle('T', parent=styles['Heading1'],
                                  fontSize=22, textColor=colors.HexColor('#6C63FF'), spaceAfter=6)
    heading_style = ParagraphStyle('H', parent=styles['Heading2'],
                                    fontSize=14, textColor=colors.HexColor('#333333'), spaceAfter=8, spaceBefore=12)
    body_style = ParagraphStyle('B', parent=styles['Normal'],
                                 fontSize=11, leading=16, spaceAfter=6)
    bullet_style = ParagraphStyle('Bullet', parent=styles['Normal'],
                                   fontSize=11, leading=16, leftIndent=20, spaceAfter=4)

    meeting_type = minutes.get("type", "meeting")

    story.append(Paragraph("MinutesAI", title_style))
    story.append(Paragraph(minutes.get("meeting_title", "Minutes"), styles['Heading1']))
    story.append(Paragraph(f"Date: {minutes.get('date', '')} | Type: {meeting_type.upper()}", body_style))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Executive Summary", heading_style))
    story.append(Paragraph(minutes.get("executive_summary", ""), body_style))
    story.append(Spacer(1, 8))

    if meeting_type == "lecture":
        if minutes.get("instructor"):
            story.append(Paragraph(f"Instructor: {minutes['instructor']}", body_style))
        if minutes.get("subject"):
            story.append(Paragraph(f"Subject: {minutes['subject']}", body_style))
        if minutes.get("key_concepts"):
            story.append(Paragraph("Key Concepts", heading_style))
            for c in minutes["key_concepts"]:
                story.append(Paragraph(f"• {c}", bullet_style))
        if minutes.get("important_points"):
            story.append(Paragraph("Important Points", heading_style))
            for i, p in enumerate(minutes["important_points"], 1):
                story.append(Paragraph(f"{i}. {p}", bullet_style))
        if minutes.get("definitions"):
            story.append(Paragraph("Definitions", heading_style))
            for d in minutes["definitions"]:
                story.append(Paragraph(f"• {d}", bullet_style))
        if minutes.get("quiz_questions"):
            story.append(Paragraph("Quiz Questions", heading_style))
            for i, q in enumerate(minutes["quiz_questions"], 1):
                story.append(Paragraph(f"{i}. {q}", bullet_style))
        if minutes.get("references"):
            story.append(Paragraph("References", heading_style))
            for r in minutes["references"]:
                story.append(Paragraph(f"• {r}", bullet_style))

    elif meeting_type == "webinar":
        if minutes.get("speaker"):
            story.append(Paragraph(f"Speaker: {minutes['speaker']}", body_style))
        if minutes.get("main_takeaways"):
            story.append(Paragraph("Main Takeaways", heading_style))
            for t in minutes["main_takeaways"]:
                story.append(Paragraph(f"• {t}", bullet_style))
        if minutes.get("topics_covered"):
            story.append(Paragraph("Topics Covered", heading_style))
            for t in minutes["topics_covered"]:
                story.append(Paragraph(f"• {t}", bullet_style))
        if minutes.get("qa_summary"):
            story.append(Paragraph("Q&A Summary", heading_style))
            story.append(Paragraph(minutes["qa_summary"], body_style))
        if minutes.get("resources_shared"):
            story.append(Paragraph("Resources Shared", heading_style))
            for r in minutes["resources_shared"]:
                story.append(Paragraph(f"• {r}", bullet_style))
        if minutes.get("action_items"):
            story.append(Paragraph("Action Items", heading_style))
            for item in minutes["action_items"]:
                story.append(Paragraph(
                    f"• {item.get('task','')} | Deadline: {item.get('deadline','TBD')} | Priority: {item.get('priority','')}",
                    bullet_style))

    else:
        if minutes.get("key_decisions"):
            story.append(Paragraph("Key Decisions", heading_style))
            for i, d in enumerate(minutes["key_decisions"], 1):
                story.append(Paragraph(f"{i}. {d}", bullet_style))
        if minutes.get("action_items"):
            story.append(Paragraph("Action Items", heading_style))
            data = [["Task", "Owner", "Deadline", "Priority"]]
            for item in minutes["action_items"]:
                task = item.get("task", "")
                if len(task) > 40:
                    task = task[:40] + "..."
                deadline = item.get("deadline", "")
                if len(deadline) > 30:
                    deadline = deadline[:30] + "..."
                owner = item.get("owner", "")
                if len(owner) > 12:
                    owner = owner[:12] + "..."
                data.append([task, owner, deadline, item.get("priority", "")])
            table = Table(data, colWidths=[250, 90, 130, 60])
            table.setStyle([
                ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#6C63FF')),
                ('TEXTCOLOR', (0,0), (-1,0), colors.white),
                ('FONTSIZE', (0,0), (-1,-1), 10),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#F5F5F5')]),
                ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#DDDDDD')),
                ('PADDING', (0,0), (-1,-1), 6),
                ('WORDWRAP', (0,0), (-1,-1), True),
('VALIGN', (0,0), (-1,-1), 'TOP'),
('FONTSIZE', (0,0), (-1,-1), 9),
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