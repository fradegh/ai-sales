"""
Max Personal Microservice
Handles Max messenger personal account connections via web.max.ru.
Uses Playwright to capture QR code from web interface.
"""

import asyncio
import json
import os
import shutil
import base64
from datetime import datetime
from typing import Optional
from pathlib import Path
import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Max Personal Service")

SESSIONS_DIR = Path("./max_sessions")
SESSIONS_DIR.mkdir(exist_ok=True)

NODE_BACKEND_URL = os.environ.get("NODE_BACKEND_URL", "http://localhost:5000")
INTERNAL_SECRET = os.environ.get("MAX_INTERNAL_SECRET") or os.environ.get("SESSION_SECRET", "")

MAX_WEB_URL = "https://web.max.ru"

class SessionState:
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        self.status = "disconnected"
        self.qr_code: Optional[str] = None
        self.qr_data_url: Optional[str] = None
        self.access_token: Optional[str] = None
        self.user_id: Optional[str] = None
        self.user_name: Optional[str] = None
        self.phone: Optional[str] = None
        self.error: Optional[str] = None
        self.browser = None
        self.page = None
        self.context = None
        self.playwright = None  # Track playwright instance for cleanup
        self.poll_task: Optional[asyncio.Task] = None
        self.qr_refresh_task: Optional[asyncio.Task] = None
        self.message_monitor_task: Optional[asyncio.Task] = None

# Limit concurrent browser sessions
MAX_CONCURRENT_SESSIONS = 5
session_semaphore = asyncio.Semaphore(MAX_CONCURRENT_SESSIONS)

sessions: dict[str, SessionState] = {}

class StartAuthRequest(BaseModel):
    tenant_id: str

class SendMessageRequest(BaseModel):
    tenant_id: str
    chat_id: str
    text: str

class CheckStatusRequest(BaseModel):
    tenant_id: str

class LogoutRequest(BaseModel):
    tenant_id: str

async def forward_message_to_node(tenant_id: str, message_data: dict):
    """Forward incoming Max message to Node.js backend for AI processing"""
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{NODE_BACKEND_URL}/api/max-personal/incoming",
                json={
                    "tenant_id": tenant_id,
                    "message": message_data
                },
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Secret": INTERNAL_SECRET
                }
            ) as response:
                if response.status != 200:
                    print(f"[MaxPersonal] Failed to forward message to Node.js: {response.status}")
                else:
                    print(f"[MaxPersonal] Message forwarded to Node.js for tenant {tenant_id}")
    except Exception as e:
        print(f"[MaxPersonal] Error forwarding message: {e}")

async def capture_qr_from_web(session_state: SessionState) -> dict:
    """
    Use Playwright to open web.max.ru and capture the QR code
    """
    try:
        from playwright.async_api import async_playwright
        
        # Acquire semaphore to limit concurrent sessions
        async with session_semaphore:
            print(f"[MaxPersonal] Starting Playwright for tenant {session_state.tenant_id}")
            
            playwright = await async_playwright().start()
            session_state.playwright = playwright  # Store for cleanup
            
            # Launch browser in headless mode
            browser = await playwright.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ]
        )
        
        session_state.browser = browser
        
        # Create context with proper user agent
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
            locale="ru-RU"
        )
        session_state.context = context
        
        page = await context.new_page()
        session_state.page = page
        
        print(f"[MaxPersonal] Navigating to {MAX_WEB_URL}")
        
        # Navigate to Max web
        await page.goto(MAX_WEB_URL, wait_until="networkidle", timeout=30000)
        
        # Wait for QR code to appear
        await asyncio.sleep(3)
        
        # Debug: Log page structure to find QR element
        try:
            # Find all elements and their sizes
            elements_info = await page.evaluate("""
                () => {
                    const result = [];
                    // Look for canvas, svg, img elements
                    ['canvas', 'svg', 'img'].forEach(tag => {
                        document.querySelectorAll(tag).forEach((el, i) => {
                            const rect = el.getBoundingClientRect();
                            result.push({
                                tag: tag,
                                index: i,
                                width: rect.width,
                                height: rect.height,
                                className: el.className,
                                id: el.id,
                                src: el.src ? el.src.substring(0, 100) : null
                            });
                        });
                    });
                    return result;
                }
            """)
            print(f"[MaxPersonal] Page elements: {elements_info}")
        except Exception as e:
            print(f"[MaxPersonal] Debug eval error: {e}")
        
        # Try to find QR code on the page
        # web.max.ru uses canvas for QR code rendering
        qr_selectors = [
            # Canvas elements (most likely for QR)
            "canvas[width='200']",
            "canvas[height='200']",
            "canvas",
            # SVG QR codes
            "svg[viewBox*='0 0']",
            # Image-based QR
            "img[alt*='QR']",
            "img[alt*='qr']", 
            "img[src*='qr']",
            # Class-based selectors
            "[class*='qr']",
            "[class*='QR']",
            "[data-testid*='qr']",
            ".qr-code",
            "#qr-code",
        ]
        
        qr_element = None
        for selector in qr_selectors:
            try:
                elements = await page.query_selector_all(selector)
                for element in elements:
                    # Check if element is visible and has reasonable size (QR code size)
                    box = await element.bounding_box()
                    if box and box['width'] >= 100 and box['height'] >= 100 and box['width'] <= 400:
                        qr_element = element
                        print(f"[MaxPersonal] Found QR element with selector: {selector}, size: {box['width']}x{box['height']}")
                        break
                if qr_element:
                    break
            except:
                continue
        
        if qr_element:
            # Take screenshot of QR element only
            qr_screenshot = await qr_element.screenshot()
            qr_data_url = f"data:image/png;base64,{base64.b64encode(qr_screenshot).decode()}"
            
            return {
                "success": True,
                "qr_data_url": qr_data_url,
                "qr_code": "max-web-qr"
            }
        
        # Fallback: try to find a container with QR
        print("[MaxPersonal] No direct QR element found, looking for QR container...")
        
        # Look for divs that might contain the QR code based on size
        all_divs = await page.query_selector_all("div")
        for div in all_divs:
            try:
                box = await div.bounding_box()
                # QR containers are typically square-ish and between 150-350px
                if box and 150 <= box['width'] <= 350 and 150 <= box['height'] <= 350:
                    # Check if this div contains a canvas
                    canvas = await div.query_selector("canvas")
                    if canvas:
                        qr_screenshot = await canvas.screenshot()
                        qr_data_url = f"data:image/png;base64,{base64.b64encode(qr_screenshot).decode()}"
                        print(f"[MaxPersonal] Found QR in container, size: {box['width']}x{box['height']}")
                        return {
                            "success": True,
                            "qr_data_url": qr_data_url,
                            "qr_code": "max-web-qr"
                        }
            except:
                continue
        
        # Last fallback: take screenshot of visible viewport center area
        print("[MaxPersonal] Taking center crop of page as QR fallback")
        
        # Take full screenshot and we'll use JavaScript to find QR position
        full_screenshot = await page.screenshot()
        qr_data_url = f"data:image/png;base64,{base64.b64encode(full_screenshot).decode()}"
        
        return {
            "success": True,
            "qr_data_url": qr_data_url,
            "qr_code": "max-web-page",
            "message": "Отсканируйте QR-код на скриншоте страницы"
        }
        
        return {
            "success": False,
            "error": "Could not capture QR code from web.max.ru"
        }
        
    except Exception as e:
        print(f"[MaxPersonal] Playwright error: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e)
        }

async def monitor_incoming_messages(tenant_id: str):
    """Monitor page for incoming messages after authentication"""
    session = sessions.get(tenant_id)
    if not session or not session.page:
        return
    
    page = session.page
    seen_messages = set()
    
    print(f"[MaxPersonal] Starting message monitor for tenant {tenant_id}")
    
    try:
        while session.status == "connected":
            try:
                # Extract messages from page using JavaScript
                messages = await page.evaluate("""
                    () => {
                        const messages = [];
                        // Look for message containers - adjust selectors based on actual Max UI
                        const msgElements = document.querySelectorAll('[class*="message"], [class*="Message"], [data-message-id]');
                        
                        // Try to find current chat/contact info
                        const chatHeader = document.querySelector('[class*="header"] [class*="name"], [class*="chat-header"] [class*="title"]');
                        const chatName = chatHeader ? chatHeader.innerText : 'Unknown';
                        
                        // Try to get chat ID from URL or page
                        const urlMatch = window.location.href.match(/chat[_\\/]([a-zA-Z0-9_-]+)/);
                        const chatId = urlMatch ? urlMatch[1] : 'default_chat';
                        
                        msgElements.forEach((el, i) => {
                            const text = el.innerText || el.textContent;
                            const id = el.getAttribute('data-message-id') || el.id || `msg_${i}_${Date.now()}`;
                            
                            // Detect if message is incoming (from customer) or outgoing (from operator)
                            const isIncoming = el.classList.contains('incoming') || 
                                               el.classList.contains('received') ||
                                               el.classList.contains('in') ||
                                               (!el.classList.contains('outgoing') && 
                                                !el.classList.contains('sent') && 
                                                !el.classList.contains('out'));
                            
                            // Try to find sender name
                            const senderEl = el.querySelector('[class*="sender"], [class*="author"], [class*="name"]');
                            const senderName = senderEl ? senderEl.innerText : (isIncoming ? chatName : 'Me');
                            
                            if (text && text.trim()) {
                                messages.push({
                                    id: id,
                                    text: text.trim().substring(0, 1000),
                                    isIncoming: isIncoming,
                                    chatId: chatId,
                                    chatName: chatName,
                                    senderName: senderName,
                                    timestamp: Date.now()
                                });
                            }
                        });
                        return messages.slice(-20); // Last 20 messages
                    }
                """)
                
                # Process new incoming messages
                for msg in messages:
                    msg_id = msg.get('id', '')
                    if msg_id and msg_id not in seen_messages and msg.get('isIncoming'):
                        seen_messages.add(msg_id)
                        print(f"[MaxPersonal] New message for {tenant_id}: {msg.get('text', '')[:50]}...")
                        
                        # Forward to Node.js backend with chat_id
                        await forward_message_to_node(tenant_id, {
                            "id": msg_id,
                            "chat_id": msg.get('chatId', 'default_chat'),
                            "text": msg.get('text', ''),
                            "sender_name": msg.get('senderName', 'Customer'),
                            "chat_name": msg.get('chatName', 'Unknown'),
                            "channel": "max_personal",
                            "timestamp": msg.get('timestamp')
                        })
                
            except Exception as e:
                print(f"[MaxPersonal] Message monitor error: {e}")
            
            await asyncio.sleep(2)  # Check every 2 seconds
            
    except asyncio.CancelledError:
        print(f"[MaxPersonal] Message monitor cancelled for {tenant_id}")
    except Exception as e:
        print(f"[MaxPersonal] Message monitor fatal error: {e}")


async def monitor_auth_status(tenant_id: str):
    """Monitor page for successful authentication"""
    session = sessions.get(tenant_id)
    if not session or not session.page:
        return
    
    page = session.page
    
    try:
        max_attempts = 120  # 4 minutes
        for _ in range(max_attempts):
            if session.status == "connected" or session.status == "disconnected":
                break
            
            try:
                # Check if we're authenticated by looking for chat interface elements
                chat_element = await page.query_selector("[data-testid='chat']")
                main_content = await page.query_selector(".main-content")
                messages_area = await page.query_selector(".messages")
                
                # Alternative: check for sidebar with chats
                sidebar = await page.query_selector("[class*='sidebar'], [class*='Sidebar'], [class*='chat-list']")
                
                # Check URL for authenticated state
                current_url = page.url
                
                if any([chat_element, main_content, messages_area, sidebar]) or "chat" in current_url.lower():
                    session.status = "connected"
                    session.user_name = "Max User"
                    print(f"[MaxPersonal] Tenant {tenant_id} authenticated successfully")
                    
                    # Start message monitoring
                    session.message_monitor_task = asyncio.create_task(
                        monitor_incoming_messages(tenant_id)
                    )
                    break
                
                # Check if QR was scanned (page might reload or change)
                qr_element = await page.query_selector("canvas")
                if not qr_element:
                    # QR disappeared - might be in transition or authenticated
                    await asyncio.sleep(1)
                    # Check again for auth elements
                    chat_element = await page.query_selector("[data-testid='chat']")
                    if chat_element:
                        session.status = "connected"
                        session.message_monitor_task = asyncio.create_task(
                            monitor_incoming_messages(tenant_id)
                        )
                        break
                        
            except Exception as e:
                print(f"[MaxPersonal] Monitor check error: {e}")
            
            await asyncio.sleep(2)
            
    except Exception as e:
        print(f"[MaxPersonal] Monitor error: {e}")

async def refresh_qr_periodically(tenant_id: str):
    """Refresh QR code every 30 seconds to keep it valid"""
    session = sessions.get(tenant_id)
    if not session or not session.page:
        return
    
    try:
        while session.status == "qr_ready":
            await asyncio.sleep(30)
            
            if session.status != "qr_ready":
                break
            
            try:
                # Check if QR is still visible
                qr_selectors = ["canvas", "img[alt*='QR']", "img[src*='qr']"]
                for selector in qr_selectors:
                    qr_element = await session.page.query_selector(selector)
                    if qr_element:
                        qr_screenshot = await qr_element.screenshot()
                        session.qr_data_url = f"data:image/png;base64,{base64.b64encode(qr_screenshot).decode()}"
                        print(f"[MaxPersonal] QR refreshed for tenant {tenant_id}")
                        break
            except Exception as e:
                print(f"[MaxPersonal] QR refresh error: {e}")
                
    except asyncio.CancelledError:
        pass

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "max-personal"}

@app.post("/start-auth")
async def start_auth(request: StartAuthRequest):
    """Start Max Personal authentication with QR code from web.max.ru"""
    tenant_id = request.tenant_id
    
    try:
        session = sessions.get(tenant_id)
        if session and session.status == "connected":
            return JSONResponse({
                "success": True,
                "status": "already_connected",
                "user": {
                    "id": session.user_id,
                    "name": session.user_name,
                    "phone": session.phone
                }
            })
        
        # Clean up old session
        if session:
            await cleanup_session(tenant_id)
        
        session = SessionState(tenant_id)
        session.status = "connecting"
        sessions[tenant_id] = session
        
        # Capture QR from web.max.ru using Playwright
        qr_result = await capture_qr_from_web(session)
        
        if qr_result.get("success"):
            session.qr_code = qr_result.get("qr_code", "max-qr")
            session.qr_data_url = qr_result.get("qr_data_url")
            session.status = "qr_ready"
            
            # Start monitoring for authentication
            session.poll_task = asyncio.create_task(monitor_auth_status(tenant_id))
            
            # Start QR refresh task
            session.qr_refresh_task = asyncio.create_task(refresh_qr_periodically(tenant_id))
            
            return JSONResponse({
                "success": True,
                "status": "qr_ready",
                "qr_code": session.qr_code,
                "qr_data_url": session.qr_data_url,
                "message": qr_result.get("message", "Отсканируйте QR-код в приложении Max на телефоне")
            })
        else:
            session.status = "error"
            session.error = qr_result.get("error", "Failed to get QR code")
            return JSONResponse({
                "success": False,
                "error": session.error
            }, status_code=500)
        
    except Exception as e:
        print(f"[MaxPersonal] Start auth error: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)

async def cleanup_session(tenant_id: str):
    """Clean up browser, playwright and tasks for a session"""
    session = sessions.get(tenant_id)
    if not session:
        return
    
    print(f"[MaxPersonal] Cleaning up session for tenant {tenant_id}")
    
    if session.poll_task:
        session.poll_task.cancel()
        try:
            await session.poll_task
        except asyncio.CancelledError:
            pass
    
    if session.qr_refresh_task:
        session.qr_refresh_task.cancel()
        try:
            await session.qr_refresh_task
        except asyncio.CancelledError:
            pass
    
    if session.message_monitor_task:
        session.message_monitor_task.cancel()
        try:
            await session.message_monitor_task
        except asyncio.CancelledError:
            pass
    
    if session.context:
        try:
            await session.context.close()
        except:
            pass
    
    if session.browser:
        try:
            await session.browser.close()
        except:
            pass
    
    # Stop playwright instance to prevent process leaks
    if session.playwright:
        try:
            await session.playwright.stop()
        except:
            pass

@app.post("/check-auth")
async def check_auth(request: CheckStatusRequest):
    """Check Max Personal authentication status"""
    tenant_id = request.tenant_id
    session = sessions.get(tenant_id)
    
    if not session:
        return JSONResponse({
            "status": "disconnected",
            "connected": False
        })
    
    # Try to refresh QR if still in qr_ready state
    if session.status == "qr_ready" and session.page:
        try:
            qr_selectors = ["canvas", "img[alt*='QR']", "img[src*='qr']"]
            for selector in qr_selectors:
                qr_element = await session.page.query_selector(selector)
                if qr_element:
                    qr_screenshot = await qr_element.screenshot()
                    session.qr_data_url = f"data:image/png;base64,{base64.b64encode(qr_screenshot).decode()}"
                    break
        except:
            pass
    
    return JSONResponse({
        "status": session.status,
        "connected": session.status == "connected",
        "qr_code": session.qr_code,
        "qr_data_url": session.qr_data_url,
        "user": {
            "id": session.user_id,
            "name": session.user_name,
            "phone": session.phone
        } if session.status == "connected" else None,
        "error": session.error
    })

@app.post("/logout")
async def logout(request: LogoutRequest):
    """Logout from Max Personal"""
    tenant_id = request.tenant_id
    
    await cleanup_session(tenant_id)
    
    if tenant_id in sessions:
        del sessions[tenant_id]
    
    # Clear session directory
    session_dir = SESSIONS_DIR / tenant_id
    if session_dir.exists():
        shutil.rmtree(session_dir)
    
    return JSONResponse({
        "success": True,
        "message": "Logged out successfully"
    })

@app.post("/send-message")
async def send_message(request: SendMessageRequest):
    """Send message via Max Personal"""
    tenant_id = request.tenant_id
    session = sessions.get(tenant_id)
    
    if not session or session.status != "connected":
        return JSONResponse({
            "success": False,
            "error": "Not connected"
        }, status_code=400)
    
    try:
        if session.page:
            # Use Playwright to send message through web interface
            # This is a simplified implementation - actual implementation would need
            # to navigate to the correct chat and type the message
            
            # Find message input
            input_selector = "textarea, input[type='text'], [contenteditable='true']"
            input_element = await session.page.query_selector(input_selector)
            
            if input_element:
                await input_element.fill(request.text)
                await input_element.press("Enter")
                
                return JSONResponse({
                    "success": True,
                    "message_id": f"max_{datetime.now().timestamp()}",
                    "timestamp": datetime.now().isoformat()
                })
            else:
                return JSONResponse({
                    "success": False,
                    "error": "Could not find message input"
                }, status_code=400)
        else:
            return JSONResponse({
                "success": False,
                "error": "No active browser session"
            }, status_code=400)
            
    except Exception as e:
        print(f"[MaxPersonal] Send message error: {e}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)

@app.get("/status/{tenant_id}")
async def get_status(tenant_id: str):
    """Get connection status for a tenant"""
    session = sessions.get(tenant_id)
    
    if not session:
        return JSONResponse({
            "connected": False,
            "status": "disconnected"
        })
    
    return JSONResponse({
        "connected": session.status == "connected",
        "status": session.status,
        "user": {
            "id": session.user_id,
            "name": session.user_name,
            "phone": session.phone
        } if session.status == "connected" else None
    })

if __name__ == "__main__":
    import uvicorn
    print("[MaxPersonal] Starting service on port 8100 with Playwright support")
    uvicorn.run(app, host="0.0.0.0", port=8100, log_level="info")
