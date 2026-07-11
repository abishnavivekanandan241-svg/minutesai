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
        f"&language=en-US"
        f"&smart_format=true"
        f"&punctuate=true"
        f"&interim_results=true"
        f"&encoding=linear16"
        f"&sample_rate=16000"
        f"&channels=1"
    )
    
    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}"
    }
    
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
    
    client = Groq(api_key=GROQ_API_KEY)
    
    message = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": f"""First detect the type of this transcript, then return ONLY a valid JSON object with no other text.

Detection rules:
- If transcript has instructor/teacher/professor explaining concepts = "lecture"
- If transcript has presenter/host with audience Q&A = "webinar"  
- If transcript has team discussion, decisions, tasks = "meeting"

Return this JSON based on type:

If type is "lecture":
{{
    "type": "lecture",
    "meeting_title": "topic of the lecture",
    "date": "today",
    "duration": "estimated duration",
    "subject": "subject or course name",
    "instructor": "instructor name if mentioned",
    "key_concepts": ["concept 1", "concept 2", "concept 3"],
    "executive_summary": "3 sentences summarizing what was taught",
    "important_points": ["point 1", "point 2", "point 3"],
    "definitions": ["term: definition", "term: definition"],
    "references": ["reference 1", "reference 2"],
    "quiz_questions": ["question 1?", "question 2?", "question 3?"]
}}

If type is "webinar":
{{
    "type": "webinar",
    "meeting_title": "webinar title",
    "date": "today",
    "duration": "estimated duration",
    "speaker": "speaker name if mentioned",
    "executive_summary": "3 sentences summarizing the webinar",
    "main_takeaways": ["takeaway 1", "takeaway 2", "takeaway 3"],
    "topics_covered": ["topic 1", "topic 2"],
    "resources_shared": ["resource 1", "resource 2"],
    "qa_summary": "summary of Q&A if any",
    "action_items": [
        {{
            "task": "what to do after webinar",
            "deadline": "TBD",
            "priority": "high or medium or low"
        }}
    ]
}}

If type is "meeting":
{{
    "type": "meeting",
    "meeting_title": "generated title based on content",
    "date": "today",
    "duration": "estimated duration",
    "attendees": ["name1", "name2"],
    "executive_summary": "3 clear sentences summarizing the meeting",
    "key_decisions": ["decision 1", "decision 2"],
    "action_items": [
        {{
            "task": "what needs to be done",
            "owner": "person responsible",
            "deadline": "mentioned deadline or TBD",
            "priority": "high or medium or low"
        }}
    ],
    "topics_discussed": ["topic1", "topic2"],
    "next_meeting": "next meeting info or null"
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
    
    tmp = tempfile.NamedTemporaryFile(
        delete=False,
        suffix=".pdf"
    )
    
    doc = SimpleDocTemplate(tmp.name, pagesize=letter)
    styles = getSampleStyleSheet()
    story = []
    
    title_style = ParagraphStyle(
        'Title',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#6C63FF'),
        spaceAfter=12
    )
    
    heading_style = ParagraphStyle(
        'Heading',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#333333'),
        spaceAfter=8
    )
    
    story.append(Paragraph("MinutesAI", title_style))
    story.append(Paragraph(
        minutes.get("meeting_title", "Meeting Minutes"),
        styles['Heading1']
    ))
    story.append(Spacer(1, 12))
    
    story.append(Paragraph("Executive Summary", heading_style))
    story.append(Paragraph(
        minutes.get("executive_summary", ""),
        styles['Normal']
    ))
    story.append(Spacer(1, 12))
    
    if minutes.get("key_decisions"):
        story.append(Paragraph("Key Decisions", heading_style))
        for i, decision in enumerate(minutes["key_decisions"], 1):
            story.append(Paragraph(
                f"{i}. {decision}",
                styles['Normal']
            ))
        story.append(Spacer(1, 12))
    
    if minutes.get("action_items"):
        story.append(Paragraph("Action Items", heading_style))
        data = [["Task", "Owner", "Deadline", "Priority"]]
        for item in minutes["action_items"]:
            data.append([
                item.get("task", ""),
                item.get("owner", ""),
                item.get("deadline", ""),
                item.get("priority", "")
            ])
        table = Table(data, colWidths=[200, 100, 100, 80])
        story.append(table)
    
    doc.build(story)
    
    return FileResponse(
        tmp.name,
        media_type="application/pdf",
        filename="meeting-minutes.pdf"
    )