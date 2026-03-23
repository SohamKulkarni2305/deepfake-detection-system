import os
import time
import json
import google.generativeai as genai
from flask import Flask, render_template, request, jsonify, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash 
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin, login_user, LoginManager, login_required, logout_user, current_user
from PIL import Image
from dotenv import load_dotenv
import traceback
from datetime import timedelta

# 1. INITIAL SETUP
load_dotenv()
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# --- SMART MODEL DISCOVERY ---
genai.configure(api_key=GOOGLE_API_KEY)

def discover_best_model():
    print("\n[SYSTEM] Initializing Advanced Forensic Engine...")
    try:
        available = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods]
        # Priority: Pro is much better at spotting physical/structural errors
        priority = ['models/gemini-1.5-pro', 'models/gemini-1.5-flash', 'models/gemini-1.5-flash-latest']
        for p in priority:
            if p in available:
                print(f"[SYSTEM] Using Model: {p}")
                return p
        return available[0]
    except Exception as e:
        print(f"[CRITICAL] Discovery failed: {e}")
        return 'models/gemini-1.5-flash'

SELECTED_MODEL = discover_best_model()
vision_model = genai.GenerativeModel(
    model_name=SELECTED_MODEL,
    generation_config={"temperature": 0.1, "response_mime_type": "application/json"}
)

# --- FLASK & DATABASE CONFIG ---
app = Flask(__name__)
app.config['SECRET_KEY'] = 'deepscan-forensic-security-v2'

# --- THE FIX: Force the absolute path ---
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, 'static', 'uploads')
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
# ----------------------------------------

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///deepscan.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# --- DATABASE SCHEMAS ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100))
    email = db.Column(db.String(100), unique=True)
    password = db.Column(db.String(200))

class ScanHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    image_path = db.Column(db.String(200))
    result_score = db.Column(db.String(50))
    verdict = db.Column(db.String(50))
    explanation = db.Column(db.Text)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- THE ADVANCED FORENSIC ENGINE ---
class DeepFakeDetector:
    def predict(self, image_path):
        try:
            # We don't shrink the image too much so the AI can see structural flaws
            img = Image.open(image_path)
            if img.mode in ("RGBA", "P"): img = img.convert("RGB")

            # THE "PHYSICS & TOPOLOGY" PROMPT
            # This forces Gemini to look at HOW the objects are built, not just how they look.
            prompt = """
You are an AI forensic image analyst.

Analyze the image carefully for signs of synthetic generation such as:
- Inconsistent facial symmetry
- Unnatural lighting or shadows
- Texture irregularities
- Blurred object boundaries
- Anatomical distortions
- GAN artifacts

Important:
- Do NOT assume the image is artificial unless there is strong visual evidence.
- Minor compression artifacts or perspective distortion should NOT be considered fake.
- Only classify as 'Artificial' if multiple strong indicators exist.

Return ONLY this JSON:

{
  "verdict": "Artificial" or "Authentic",
  "confidence": 0-100,
  "structural_flaws": "Specific detected issues or 'None'",
  "technical_reason": "Short explanation"
}
"""

            response = vision_model.generate_content([prompt, img])
            
            raw_text = response.text
            if "```json" in raw_text:
                raw_text = raw_text.split("```json")[1].split("```")[0].strip()
            
            data = json.loads(raw_text)

            # --- VERDICT OVERRIDE LOGIC ---
            # If the AI detected specific structural flaws, we force the verdict to Artificial 
            # even if the general texture looks 'authentic'.
            final_verdict = data.get("verdict", "Authentic")
            flaws = data.get("structural_flaws", "").lower()
            
            #if flaws and "none" not in flaws and "no flaws" not in flaws:
             #   final_verdict = "Artificial"

            return {
                "verdict": final_verdict,
                "confidence": data.get("confidence", 85),
                "explanation": f"Flaws: {data.get('structural_flaws')}. Reason: {data.get('technical_reason')}",
                "status": "warning" if final_verdict == "Artificial" else "safe",
                "color": "#ff4444" if final_verdict == "Artificial" else "#00ffa3"
            }
        except Exception:
            traceback.print_exc()
            return None

detector = DeepFakeDetector()

# --- ROUTES ---
@app.route("/")
def index():
    recent_scans = []
    if current_user.is_authenticated:
        # Fetch the last 4 scans for the dashboard preview
        recent_scans = ScanHistory.query.filter_by(user_id=current_user.id)\
                                 .order_by(ScanHistory.timestamp.desc())\
                                 .limit(4).all()
    return render_template("index.html", user=current_user, recent_scans=recent_scans)

@app.route("/analyze", methods=["POST"])
def analyze_photo():
    import time
    import os

    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400

    file = request.files["file"]

    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    # --- THE BULLETPROOF FILENAME FIX ---
    # 1. Extract just the extension (e.g., '.png' or '.jpg')
    _, ext = os.path.splitext(file.filename)
    if not ext:
        ext = ".jpg"  # Fallback if the file has no extension
        
    # 2. Get a clean, whole-number timestamp
    unique_id = str(int(time.time()))
    
    # 3. Create a perfect filename: e.g., "1708801200.jpg"
    filename = f"{unique_id}{ext}"
    # ------------------------------------

    # Save file
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)

    # Run AI detection
    result = detector.predict(filepath)

    if not result:
        return jsonify({"error": "Forensic Engine busy. Please try again."}), 500

    # Save to DB only if logged in
    if current_user.is_authenticated:
        new_scan = ScanHistory(
            user_id=current_user.id,
            image_path=filename,   
            verdict=result["verdict"],
            result_score=f"{result['confidence']}%",
            explanation=result["explanation"]
        )
        db.session.add(new_scan)
        db.session.commit()

    return jsonify({
        "success": True,
        "results": [{
            "provider": f"Gemini Forensic ({SELECTED_MODEL})",
            "score": f"{result['confidence']}% {result['verdict']}",
            "explanation": result["explanation"],
            "status": result["status"],
            "color": result["color"]
        }]
    })
@app.route("/register", methods=["POST"])
def register():
    data = request.get_json()

    if User.query.filter_by(email=data["email"]).first():
        return jsonify({"success": False, "message": "User already exists"})

    user = User(
        name=data["name"],
        email=data["email"],
        password=generate_password_hash(data["pass"])  # <-- IMPORTANT keep 'pass'
    )

    db.session.add(user)
    db.session.commit()

    return jsonify({"success": True})

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":

        # Accept form data (because you send FormData)
        email = request.form.get("email")
        password = request.form.get("password")

        user = User.query.filter_by(email=email).first()

        if user and check_password_hash(user.password, password):
            login_user(user)
            return jsonify({"success": True})

        return jsonify({"success": False, "message": "Invalid email or password"})

    return render_template("login.html")

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("index"))

@app.route('/history')
@login_required
def history():
    scans = ScanHistory.query.filter_by(user_id=current_user.id)\
                             .order_by(ScanHistory.timestamp.desc())\
                             .all()
    return render_template('history.html', scans=scans,timedelta=timedelta)



@app.route("/delete_scan/<int:scan_id>", methods=["POST"])
@login_required
def delete_scan(scan_id):
    scan = ScanHistory.query.get_or_404(scan_id)

    # Security check – user can delete only their own scans
    if scan.user_id != current_user.id:
        return "Unauthorized", 403

    # Delete image file from folder
    image_path = os.path.join(app.config["UPLOAD_FOLDER"], scan.image_path)
    if os.path.exists(image_path):
        os.remove(image_path)

    # Delete from database
    db.session.delete(scan)
    db.session.commit()

    return redirect(url_for("history"))

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True)