"""
Squat rep counter + form checker  (v3: live webcam AND video-file testing)

Works with both MediaPipe APIs (legacy `mp.solutions` and the newer Tasks API; the
Tasks model file is downloaded automatically the first time).

Install:  pip install opencv-python mediapipe numpy

LIVE webcam (same as before):
    python squat_tracker_v3.py
    python squat_tracker_v3.py --source 1              (second camera)

VIDEO testing:
    python squat_tracker_v3.py --source squat.mp4
    python squat_tracker_v3.py --source a.mp4 b.mp4    (several videos, one after another)
    python squat_tracker_v3.py --source my_videos/     (every video in a folder)
    python squat_tracker_v3.py --source squat.mp4 --save           (also writes squat_annotated.mp4)
    python squat_tracker_v3.py --source my_videos/ --no-display    (fast batch mode, no window)

Other options:
    --view auto|side|front     force the camera view (default auto)
    --model lite|full|heavy    pose model size (default heavy = most accurate, 'lite' = fastest)
    --display-height 720       shrink big videos on screen (processing still uses full size)
    --depth-tolerance 20       how deep a squat must be to count as good (side view).
                               0 = strict parallel, 20 = default, 30 = quite relaxed

Keys in the window:  q = quit   space = pause/resume   n = skip to next video

Each source writes a CSV with one row per rep (video: <name>_squat_session.csv,
webcam: squat_session.csv) and prints a summary at the end.
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
START_ANGLE = 150        # knee angle below this -> descent started
STAND_ANGLE = 160        # knee angle above this -> rep finished

# SIDE view depth (thigh angle above horizontal, degrees; 0 = parallel, negative = below)
PARALLEL_TOL = 20        # <= this  -> counts as a good-depth squat (higher number = easier)
HALF_THIGH = 35    # >  this  -> half squat (bad); between = "almost"
MAX_TORSO_LEAN = 45      # degrees from vertical (side view only)

# FRONT view depth (knee angle)
DEPTH_ANGLE_FRONT = 100

SMOOTH_N = 5
MIN_VISIBILITY = 0.6
FEEDBACK_SECONDS = 2.0
FRONT_RATIO = 0.5        # shoulder-width / torso-length above this -> front view

# MediaPipe pose landmark indices (identical in both APIs)
L_SH, R_SH, L_HIP, R_HIP = 11, 12, 23, 24
LEFT_IDS = (11, 23, 25, 27)     # shoulder, hip, knee, ankle
RIGHT_IDS = (12, 24, 26, 28)

VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


# ---------------- Geometry ----------------
def joint_angle(a, b, c):
    """Angle at b formed by a-b-c, degrees."""
    ba = np.array(a, float) - np.array(b, float)
    bc = np.array(c, float) - np.array(b, float)
    cos = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    return math.degrees(math.acos(np.clip(cos, -1.0, 1.0)))


def torso_lean(shoulder, hip):
    """Angle between hip->shoulder and vertical (0 = upright). Image y points down."""
    v = np.array(shoulder, float) - np.array(hip, float)
    up = np.array([0.0, -1.0])
    cos = np.dot(v, up) / (np.linalg.norm(v) + 1e-9)
    return math.degrees(math.acos(np.clip(cos, -1.0, 1.0)))


def thigh_elevation(hip, knee):
    """How far the hip is ABOVE the knee line, in degrees from horizontal.
    ~85 standing, 0 = thigh parallel to floor, negative = below parallel."""
    dx = abs(knee[0] - hip[0])
    dy = knee[1] - hip[1]            # positive when hip is above knee (image y down)
    return math.degrees(math.atan2(dy, dx + 1e-6))


# ---------------- Rep logic (no camera needed, so it can be unit-tested) ----------------
class SquatAnalyzer:
    def __init__(self):
        self.state = "UP"
        self.good = 0
        self.bad = 0
        self.log = []
        self._reset()

    def _reset(self):
        self.min_knee, self.min_thigh, self.max_lean = 999.0, 999.0, 0.0

    def update(self, knee, thigh, lean, view, t=None):
        """Feed one smoothed frame. Returns (verdict, issues) when a rep ends, else None."""
        if self.state == "UP":
            if knee < START_ANGLE:
                self.state = "DOWN"
                self._reset()
                self._track(knee, thigh, lean)
            return None

        self._track(knee, thigh, lean)
        if knee > STAND_ANGLE:
            self.state = "UP"
            return self._judge(view, t)
        return None

    def _track(self, knee, thigh, lean):
        self.min_knee = min(self.min_knee, knee)
        self.min_thigh = min(self.min_thigh, thigh)
        self.max_lean = max(self.max_lean, lean)

    def _judge(self, view, t):
        issues = []
        if view == "side":
            if self.min_thigh > HALF_THIGH:
                issues.append("Half squat - go much deeper!")
            elif self.min_thigh > PARALLEL_TOL:
                issues.append("Almost - go a bit lower!")
            if self.max_lean > MAX_TORSO_LEAN:
                issues.append("Keep chest up!")
        else:  # front
            if self.min_knee > DEPTH_ANGLE_FRONT:
                issues.append("Squat deeper!")

        verdict = "bad" if issues else "good"
        if issues:
            self.bad += 1
        else:
            self.good += 1
        self.log.append({
            "rep": self.good + self.bad,
            "time_s": None if t is None else round(t, 2),
            "view": view,
            "min_knee_angle": round(self.min_knee, 1),
            "min_thigh_angle": round(self.min_thigh, 1),
            "max_torso_lean": round(self.max_lean, 1),
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


class SquatSession:
    """Holds all per-video state (smoothing buffers, locked side, view votes, feedback)."""

    def __init__(self, view_mode="auto"):
        self.view_mode = view_mode
        self.view = "side" if view_mode == "auto" else view_mode
        self.analyzer = SquatAnalyzer()
        self.knee_b, self.thigh_b, self.lean_b = (deque(maxlen=SMOOTH_N) for _ in range(3))
        self.votes = deque(maxlen=15)
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
        a = self.analyzer

        if lm:
            draw_skeleton(frame, lm, connections, s)

            # Choose the body side only while standing; keep it locked during a rep
            if a.state == "UP":
                self.locked = LEFT_IDS if mean_vis(lm, LEFT_IDS) >= mean_vis(lm, RIGHT_IDS) else RIGHT_IDS
            sh_i, hip_i, kn_i, an_i = self.locked
            pt = lambda i: (lm[i].x * w, lm[i].y * h)

            # View detection (only while standing)
            if self.view_mode == "auto":
                if a.state == "UP":
                    ls, rs, lh, rh = pt(L_SH), pt(R_SH), pt(L_HIP), pt(R_HIP)
                    ms = ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2)
                    mh = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2)
                    ratio = abs(ls[0] - rs[0]) / (math.dist(ms, mh) + 1e-9)
                    self.votes.append("front" if ratio > FRONT_RATIO else "side")
                if self.votes:
                    self.view = max(set(self.votes), key=self.votes.count)

            if mean_vis(lm, self.locked) >= MIN_VISIBILITY:
                self.knee_b.append(joint_angle(pt(hip_i), pt(kn_i), pt(an_i)))
                self.thigh_b.append(thigh_elevation(pt(hip_i), pt(kn_i)))
                self.lean_b.append(torso_lean(pt(sh_i), pt(hip_i)))
                knee, thigh, lean = (float(np.mean(b)) for b in (self.knee_b, self.thigh_b, self.lean_b))

                result = a.update(knee, thigh, lean, self.view, t)
                if result:
                    verdict, issues = result
                    self.feedback = "Good rep!" if verdict == "good" else " ".join(issues)
                    self.feedback_until = t + FEEDBACK_SECONDS

                if self.view == "side":
                    col = (0, 255, 0) if thigh <= PARALLEL_TOL else (0, 165, 255) if thigh <= HALF_THIGH else (0, 0, 255)
                    cv2.line(frame, tuple(map(int, pt(hip_i))), tuple(map(int, pt(kn_i))), col,
                             max(2, int(round(6 * s))))
                    info = f"Thigh: {thigh:5.1f} deg above parallel  Lean: {lean:4.1f}"
                else:
                    info = f"Knee: {knee:5.1f}"
                put(info, 10, bottom, 0.6, (255, 255, 255), 2)
            else:
                put("Make sure your whole body is visible", 10, bottom, 0.6, (0, 165, 255), 2)
        else:
            put("No person detected", 10, bottom, 0.6, (0, 165, 255), 2)

        put(f"Good: {a.good}  Bad: {a.bad}  View: {self.view.upper()}", 10, 30, 0.8, (0, 255, 0), 2)
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
        print(f"  rep {r['rep']:>2}{at} [{r['view']}] thigh {r['min_thigh_angle']:>6} "
              f"knee {r['min_knee_angle']:>6} lean {r['max_torso_lean']:>5} -> {r['verdict']} {r['issues']}")
    if a.log:
        path = "squat_session.csv" if live else f"{stem}_squat_session.csv"
        with open(path, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=a.log[0].keys())
            wr.writeheader()
            wr.writerows(a.log)
        print(f"  saved -> {path}")
    else:
        print("  no complete reps detected (check camera angle / that the full body is visible)")


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
    session = SquatSession(args.view)
    win = f"Squat Tracker - {label}"
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
                    out_path = f"{stem}_annotated.mp4"
                    h, w = frame.shape[:2]
                    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
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
            print(f"Annotated video saved -> {stem}_annotated.mp4")
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
    global PARALLEL_TOL, HALF_THIGH
    ap = argparse.ArgumentParser(description="Squat rep counter + form checker (webcam or video files)")
    ap.add_argument("--source", nargs="+", default=["0"],
                    help="webcam index, video file(s) or a folder of videos (default: webcam 0)")
    ap.add_argument("--view", choices=["auto", "side", "front"], default="auto")
    ap.add_argument("--model", choices=["lite", "full", "heavy"], default="heavy",
                    help="pose model size for the Tasks API (default heavy)")
    ap.add_argument("--save", action="store_true", help="write an annotated copy of each video (<name>_annotated.mp4)")
    ap.add_argument("--no-display", action="store_true", help="do not open a window (fast batch processing)")
    ap.add_argument("--display-height", type=int, default=720, help="max on-screen height (default 720)")
    ap.add_argument("--depth-tolerance", type=float, default=PARALLEL_TOL,
                    help="degrees the thigh may stay above parallel and still count as good "
                         "(side view; default %(default)s, higher = less deep needed)")
    args = ap.parse_args()

    PARALLEL_TOL = args.depth_tolerance
    HALF_THIGH = args.depth_tolerance + 15          # 'almost' zone is 15 deg wide

    sources = expand_sources(args.source)
    if not sources:
        raise SystemExit("Nothing to process.")
    for src in sources:
        if run_source(src, args) == "quit":
            break


if __name__ == "__main__":
    main()