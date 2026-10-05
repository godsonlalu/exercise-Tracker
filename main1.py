"""
Push-up rep counter + form checker  (rule-based, no dataset needed)
Live webcam AND video-file testing, same workflow as the squat tracker.

What it checks (film from the SIDE, whole body in frame):
  * Depth      - elbow bends enough at the bottom ("Go lower!" / "Half rep")
  * Body line  - shoulder-hip-ankle stays straight ("Hips sagging" / "Hips too high")
  * Reps only count while you are in a push-up (plank) position, so walking
    around or standing in front of the camera does not add reps.

Install:  pip install opencv-python mediapipe numpy

LIVE webcam:
    python pushup_tracker.py
    python pushup_tracker.py --source 1

VIDEO testing:
    python pushup_tracker.py --source pushups.mp4
    python pushup_tracker.py --source a.mp4 b.mp4        (several videos)
    python pushup_tracker.py --source my_videos/         (every video in a folder)
    python pushup_tracker.py --source pushups.mp4 --save           (writes <name>_pushup_annotated.mp4)
    python pushup_tracker.py --source my_videos/ --no-display      (fast batch mode)

Options:
    --depth-tolerance 10   degrees above 90 deg that the elbow may stay and still count as good depth
                           (0 = strict 90 deg, 10 = default, 20 = relaxed)
    --body-tolerance 15    degrees the body may bend away from a straight line (default 15)
    --model lite|full|heavy   pose model size (default heavy = most accurate)
    --display-height 720      shrink big videos on screen (processing still uses full size)

Keys in the window:  q = quit   space = pause/resume   n = skip to next video
Each source writes a CSV (one row per rep): webcam -> pushup_session.csv,
video -> <name>_pushup_session.csv
"""
import argparse
import csv
import math
import os
import time
import urllib.request
from collections import deque

import cv2
import numpy as np

# ---------------- Thresholds (tune with your own footage) ----------------
START_ELBOW = 140        # elbow angle below this -> going down (rep started)
END_ELBOW = 155          # elbow angle above this -> arms extended again (rep finished)
MAX_PLANK_TILT = 45      # shoulder->ankle line may be at most this far from horizontal
SMOOTH_N = 5
MIN_VISIBILITY = 0.5
FEEDBACK_SECONDS = 2.0

# MediaPipe pose landmark indices (identical in both APIs)
#             shoulder, elbow, wrist, hip, ankle
LEFT_IDS = (11, 13, 15, 23, 27)
RIGHT_IDS = (12, 14, 16, 24, 28)

VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


class Limits:
    """Depth / alignment limits derived from the CLI tolerances."""

    def __init__(self, depth_tol=10.0, body_tol=15.0):
        self.good_elbow = 90.0 + depth_tol       # min elbow angle must be <= this
        self.half_elbow = self.good_elbow + 15   # above this = half rep
        self.min_body = 180.0 - body_tol         # shoulder-hip-ankle angle must be >= this


# ---------------- Geometry ----------------
def joint_angle(a, b, c):
    """Angle at b formed by a-b-c, degrees."""
    ba = np.array(a, float) - np.array(b, float)
    bc = np.array(c, float) - np.array(b, float)
    cos = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    return math.degrees(math.acos(np.clip(cos, -1.0, 1.0)))


def body_alignment(shoulder, hip, ankle):
    """Returns (angle, sag). angle = shoulder-hip-ankle angle (180 = perfectly straight).
    sag > 0 means the hip is BELOW the shoulder-ankle line (sagging), < 0 means above (piking)."""
    ang = joint_angle(shoulder, hip, ankle)
    dx = ankle[0] - shoulder[0]
    if abs(dx) < 1e-6:
        return ang, 0.0
    y_line = shoulder[1] + (hip[0] - shoulder[0]) * (ankle[1] - shoulder[1]) / dx
    return ang, hip[1] - y_line                  # image y points down


def plank_tilt(shoulder, ankle):
    """Angle of the shoulder->ankle line from horizontal (0 = lying flat, 90 = standing)."""
    return math.degrees(math.atan2(abs(ankle[1] - shoulder[1]), abs(ankle[0] - shoulder[0]) + 1e-6))


# ---------------- Rep logic (no camera needed, so it can be unit-tested) ----------------
class PushupAnalyzer:
    def __init__(self, limits):
        self.limits = limits
        self.state = "UP"
        self.good = 0
        self.bad = 0
        self.log = []
        self._reset()

    def _reset(self):
        self.min_elbow, self.worst_body, self.worst_sag = 999.0, 999.0, 0.0

    def update(self, elbow, body_angle, sag, t=None):
        """Feed one smoothed frame. Returns (verdict, issues) when a rep ends, else None."""
        if self.state == "UP":
            if elbow < START_ELBOW:
                self.state = "DOWN"
                self._reset()
                self._track(elbow, body_angle, sag)
            return None

        self._track(elbow, body_angle, sag)
        if elbow > END_ELBOW:
            self.state = "UP"
            return self._judge(t)
        return None

    def _track(self, elbow, body_angle, sag):
        self.min_elbow = min(self.min_elbow, elbow)
        if body_angle < self.worst_body:
            self.worst_body, self.worst_sag = body_angle, sag

    def _judge(self, t):
        lim, issues = self.limits, []
        if self.min_elbow > lim.half_elbow:
            issues.append("Half rep - go much lower!")
        elif self.min_elbow > lim.good_elbow:
            issues.append("Almost - go a bit lower!")
        if self.worst_body < lim.min_body:
            issues.append("Hips sagging - tighten your core!" if self.worst_sag > 0
                          else "Hips too high - lower your hips!")

        verdict = "bad" if issues else "good"
        if issues:
            self.bad += 1
        else:
            self.good += 1
        self.log.append({
            "rep": self.good + self.bad,
            "time_s": None if t is None else round(t, 2),
            "min_elbow_angle": round(self.min_elbow, 1),
            "worst_body_angle": round(self.worst_body, 1),
            "body_issue": "none" if self.worst_body >= lim.min_body else ("sag" if self.worst_sag > 0 else "pike"),
            "verdict": verdict,
            "issues": "; ".join(issues),
        })
        return verdict, issues


# ---------------- Pose backends (legacy mp.solutions OR newer Tasks API) ----------------
class _LegacyPose:
    def __init__(self, mp):
        pose_mod = mp.solutions.pose
        self.connections = [(a, b) for a, b in pose_mod.POSE_CONNECTIONS]
        self._pose = pose_mod.Pose(min_detection_confidence=0.6, min_tracking_confidence=0.6)

    def process(self, rgb, ts_ms):
        res = self._pose.process(rgb)
        return list(res.pose_landmarks.landmark) if res.pose_landmarks else None

    def close(self):
        self._pose.close()


class _TasksPose:
    URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
           "pose_landmarker_{m}/float16/1/pose_landmarker_{m}.task")

    def __init__(self, mp, model):
        from mediapipe.tasks.python import BaseOptions, vision

        path = f"pose_landmarker_{model}.task"
        if not os.path.exists(path):
            print(f"Downloading pose model to {path} ...")
            urllib.request.urlretrieve(self.URL.format(m=model), path)

        options = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=path),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.6,
            min_tracking_confidence=0.6,
        )
        self._mp = mp
        self._landmarker = vision.PoseLandmarker.create_from_options(options)
        self.connections = [(c.start, c.end) for c in vision.PoseLandmarksConnections.POSE_LANDMARKS]
        self._last_ts = -1

    def process(self, rgb, ts_ms):
        ts = max(int(ts_ms), self._last_ts + 1)      # timestamps must strictly increase
        self._last_ts = ts
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        res = self._landmarker.detect_for_video(image, ts)
        return res.pose_landmarks[0] if res.pose_landmarks else None

    def close(self):
        self._landmarker.close()


def make_pose(model="heavy"):
    """Create a pose detector. .process(rgb, ts_ms) -> list of 33 landmarks or None."""
    try:
        import mediapipe as mp
    except ImportError:
        raise SystemExit("mediapipe is not installed. Run:  pip install mediapipe")
    try:
        _ = mp.solutions.pose
        return _LegacyPose(mp)
    except AttributeError:
        return _TasksPose(mp, model)


# ---------------- Per-video / per-session processing ----------------
def _vis(lmk):
    v = getattr(lmk, "visibility", None)
    return 1.0 if v is None else float(v)


def mean_vis(lm, ids):
    return float(np.mean([_vis(lm[i]) for i in ids]))


def draw_skeleton(frame, lm, connections, s):
    h, w = frame.shape[:2]
    th, r = max(1, int(round(2 * s))), max(2, int(round(3 * s)))
    for a, b in connections:
        cv2.line(frame, (int(lm[a].x * w), int(lm[a].y * h)),
                 (int(lm[b].x * w), int(lm[b].y * h)), (0, 255, 0), th)
    for p in lm:
        cv2.circle(frame, (int(p.x * w), int(p.y * h)), r, (255, 0, 0), -1)


class PushupSession:
    """Holds all per-video state (smoothing buffers, locked side, feedback)."""

    def __init__(self, limits):
        self.limits = limits
        self.analyzer = PushupAnalyzer(limits)
        self.elbow_b, self.body_b, self.sag_b = (deque(maxlen=SMOOTH_N) for _ in range(3))
        self.locked = LEFT_IDS
        self.feedback, self.feedback_until = "", 0.0

    def step(self, frame, lm, connections, t, progress=None):
        """Analyse one frame (landmarks may be None) and draw the overlay onto `frame`."""
        h, w = frame.shape[:2]
        s = max(0.5, h / 720.0)                       # scale text for large videos
        font = cv2.FONT_HERSHEY_SIMPLEX

        def put(msg, x, y, sc, col, th):
            cv2.putText(frame, msg, (int(x * s), int(y * s)), font, sc * s, col,
                        max(1, int(round(th * s))), cv2.LINE_AA)

        bottom = h / s - 15
        a, lim = self.analyzer, self.limits

        if lm:
            draw_skeleton(frame, lm, connections, s)

            # Choose the body side only while up; keep it locked during a rep
            if a.state == "UP":
                self.locked = LEFT_IDS if mean_vis(lm, LEFT_IDS) >= mean_vis(lm, RIGHT_IDS) else RIGHT_IDS
            sh_i, el_i, wr_i, hip_i, an_i = self.locked
            pt = lambda i: (lm[i].x * w, lm[i].y * h)

            if mean_vis(lm, self.locked) < MIN_VISIBILITY:
                put("Make sure your whole body is visible (side view)", 10, bottom, 0.6, (0, 165, 255), 2)
            elif a.state == "UP" and plank_tilt(pt(sh_i), pt(an_i)) > MAX_PLANK_TILT:
                for b in (self.elbow_b, self.body_b, self.sag_b):
                    b.clear()
                put("Get into push-up position (film from the side)", 10, bottom, 0.6, (0, 165, 255), 2)
            else:
                self.elbow_b.append(joint_angle(pt(sh_i), pt(el_i), pt(wr_i)))
                ang, sag = body_alignment(pt(sh_i), pt(hip_i), pt(an_i))
                self.body_b.append(ang)
                self.sag_b.append(sag)
                elbow, body, sagv = (float(np.mean(b)) for b in (self.elbow_b, self.body_b, self.sag_b))

                result = a.update(elbow, body, sagv, t)
                if result:
                    verdict, issues = result
                    self.feedback = "Good rep!" if verdict == "good" else " ".join(issues)
                    self.feedback_until = t + FEEDBACK_SECONDS

                straight = body >= lim.min_body
                body_col = (0, 255, 0) if straight else (0, 0, 255)
                thick = max(2, int(round(6 * s)))
                cv2.line(frame, tuple(map(int, pt(sh_i))), tuple(map(int, pt(hip_i))), body_col, thick)
                cv2.line(frame, tuple(map(int, pt(hip_i))), tuple(map(int, pt(an_i))), body_col, thick)
                for p, q in ((sh_i, el_i), (el_i, wr_i)):
                    cv2.line(frame, tuple(map(int, pt(p))), tuple(map(int, pt(q))), (0, 255, 255), thick)

                note = "" if straight else (" SAG" if sagv > 0 else " PIKE")
                put(f"Elbow: {elbow:5.1f}   Body: {body:5.1f}{note}", 10, bottom, 0.6, (255, 255, 255), 2)
        else:
            put("No person detected", 10, bottom, 0.6, (0, 165, 255), 2)

        put(f"Good: {a.good}  Bad: {a.bad}  State: {a.state}", 10, 30, 0.8, (0, 255, 0), 2)
        if t < self.feedback_until:
            col = (0, 255, 0) if self.feedback == "Good rep!" else (0, 0, 255)
            put(self.feedback, 10, 70, 0.9, col, 3)
        if progress:
            put(progress, 10, 105, 0.55, (255, 255, 255), 1)


def report(session, stem, live):
    a = session.analyzer
    print(f"\n=== {stem}: {a.good + a.bad} reps | good {a.good} | bad {a.bad} ===")
    for r in a.log:
        at = f" @{r['time_s']}s" if r["time_s"] is not None else ""
        print(f"  rep {r['rep']:>2}{at} elbow {r['min_elbow_angle']:>6} body {r['worst_body_angle']:>6} "
              f"({r['body_issue']}) -> {r['verdict']} {r['issues']}")
    if a.log:
        path = "pushup_session.csv" if live else f"{stem}_pushup_session.csv"
        with open(path, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=a.log[0].keys())
            wr.writeheader()
            wr.writerows(a.log)
        print(f"  saved -> {path}")
    else:
        print("  no complete reps detected (film from the side, whole body in frame)")


def run_source(src, args):
    """Process one webcam or video file. Returns 'done', 'next' or 'quit'."""
    live = isinstance(src, int)
    label = "webcam" if live else os.path.basename(src)
    stem = "webcam" if live else os.path.splitext(label)[0]

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print(f"Could not open {label}")
        return "done"
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps != fps or fps < 1 or fps > 240:
        fps = 30.0
    total = 0 if live else int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    pose = make_pose(args.model)
    session = PushupSession(Limits(args.depth_tolerance, args.body_tolerance))
    win = f"Push-up Tracker - {label}"
    writer, idx, outcome, t0 = None, 0, "done", time.time()
    print(f"\nProcessing {label} ..." + ("" if args.no_display else "   (q quit, space pause, n next)"))

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            ts_ms = (time.time() - t0) * 1000.0 if live else idx * 1000.0 / fps
            lm = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), ts_ms)
            progress = f"Frame {idx + 1}/{total}" if total > 0 else None
            session.step(frame, lm, pose.connections, ts_ms / 1000.0, progress)
            idx += 1

            if args.save:
                if writer is None:
                    h, w = frame.shape[:2]
                    writer = cv2.VideoWriter(f"{stem}_pushup_annotated.mp4",
                                             cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
                    if not writer.isOpened():
                        print("Warning: could not create the output video; continuing without saving.")
                        args.save = False
                        writer = None
                if writer is not None:
                    writer.write(frame)

            if not args.no_display:
                show = frame
                if frame.shape[0] > args.display_height:
                    sc = args.display_height / frame.shape[0]
                    show = cv2.resize(frame, (int(frame.shape[1] * sc), args.display_height))
                cv2.imshow(win, show)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    outcome = "quit"
                    break
                if key == ord("n"):
                    outcome = "next"
                    break
                if key == ord(" "):                       # pause
                    while True:
                        k = cv2.waitKey(50) & 0xFF
                        if k == ord(" "):
                            break
                        if k in (ord("q"), ord("n")):
                            outcome = "quit" if k == ord("q") else "next"
                            break
                    if outcome != "done":
                        break
            elif idx % 100 == 0 and total:
                print(f"  {idx}/{total} frames", end="\r")
    except KeyboardInterrupt:
        outcome = "quit"
    finally:
        cap.release()
        pose.close()
        if writer is not None:
            writer.release()
            print(f"Annotated video saved -> {stem}_pushup_annotated.mp4")
        if not args.no_display:
            try:
                cv2.destroyWindow(win)
            except cv2.error:
                pass

    report(session, stem, live)
    return outcome


def expand_sources(items):
    """Turn CLI items into webcam indices and video file paths (folders are expanded)."""
    out = []
    for it in items:
        if str(it).isdigit():
            out.append(int(it))
        elif os.path.isdir(it):
            vids = sorted(os.path.join(it, f) for f in os.listdir(it)
                          if os.path.splitext(f)[1].lower() in VIDEO_EXT)
            if not vids:
                print(f"No video files found in folder: {it}")
            out.extend(vids)
        elif os.path.isfile(it):
            out.append(it)
        else:
            print(f"File not found: {it}")
    return out


def main():
    ap = argparse.ArgumentParser(description="Push-up rep counter + form checker (webcam or video files)")
    ap.add_argument("--source", nargs="+", default=["0"],
                    help="webcam index, video file(s) or a folder of videos (default: webcam 0)")
    ap.add_argument("--model", choices=["lite", "full", "heavy"], default="heavy",
                    help="pose model size for the Tasks API (default heavy)")
    ap.add_argument("--save", action="store_true", help="write an annotated copy of each video")
    ap.add_argument("--no-display", action="store_true", help="do not open a window (fast batch processing)")
    ap.add_argument("--display-height", type=int, default=720, help="max on-screen height (default 720)")
    ap.add_argument("--depth-tolerance", type=float, default=10.0,
                    help="degrees above 90 the elbow may stay and still count as good depth (default 10)")
    ap.add_argument("--body-tolerance", type=float, default=15.0,
                    help="degrees the body may bend from a straight line (default 15)")
    args = ap.parse_args()

    sources = expand_sources(args.source)
    if not sources:
        raise SystemExit("Nothing to process.")
    for src in sources:
        if run_source(src, args) == "quit":
            break


if __name__ == "__main__":
    main()