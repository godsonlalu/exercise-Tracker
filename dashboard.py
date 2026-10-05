import os
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

st.set_page_config(
    page_title="FitForm Dashboard",
    page_icon="🏋️",
    layout="wide",
    initial_sidebar_state="expanded",
)


@st.cache_data
def list_session_files():
    root = Path(__file__).resolve().parent
    files = []
    for path in sorted(root.glob("*")):
        if path.is_file() and path.suffix.lower() == ".csv":
            files.append(path)
    return files


@st.cache_data
def load_data(file_path: str):
    df = pd.read_csv(file_path)
    df = df.copy()
    df["source_file"] = Path(file_path).name
    df["exercise"] = "unknown"

    name_lower = Path(file_path).name.lower()
    if "squat" in name_lower:
        df["exercise"] = "squat"
    elif "push" in name_lower:
        df["exercise"] = "push-up"

    if "verdict" in df.columns:
        df["verdict"] = df["verdict"].fillna("unknown").astype(str).str.lower()
    return df


def safe_divide(numerator, denominator):
    if denominator == 0:
        return 0.0
    return numerator / denominator


def format_metric(value, suffix=""):
    if pd.isna(value):
        return "0"
    return f"{value:,.1f}{suffix}"


files = list_session_files()
if not files:
    st.warning("No CSV session files were found in the workspace yet. Run the tracker to generate a file first.")
    st.stop()

# Sidebar controls
st.sidebar.title("FitForm Dashboard")
st.sidebar.caption("Exercise performance overview")

selected_file = st.sidebar.selectbox("Select session file", [f.name for f in files])
df = load_data(str(Path(__file__).resolve().parent / selected_file))

# Main header
st.title("🏋️ Exercise Performance Dashboard")
st.caption(f"Session: {selected_file}")

# Summary metrics
if "rep" in df.columns:
    total_reps = len(df)
else:
    total_reps = 0

good_reps = int((df["verdict"] == "good").sum()) if "verdict" in df.columns else 0
bad_reps = int((df["verdict"] == "bad").sum()) if "verdict" in df.columns else 0
success_rate = safe_divide(good_reps, total_reps) * 100

avg_min_knee = df["min_knee_angle"].mean() if "min_knee_angle" in df.columns else None
avg_min_thigh = df["min_thigh_angle"].mean() if "min_thigh_angle" in df.columns else None
avg_min_elbow = df["min_elbow_angle"].mean() if "min_elbow_angle" in df.columns else None
avg_body = df["worst_body_angle"].mean() if "worst_body_angle" in df.columns else None

metric_cols = st.columns(4)
metric_cols[0].metric("Total reps", total_reps)
metric_cols[1].metric("Good reps", good_reps)
metric_cols[2].metric("Bad reps", bad_reps)
metric_cols[3].metric("Good rate", f"{success_rate:.1f}%")

# Secondary metrics
secondary = st.columns(4)
secondary[0].metric(
    "Avg min knee angle",
    format_metric(avg_min_knee, "°") if avg_min_knee is not None else "N/A",
)
secondary[1].metric(
    "Avg min thigh angle",
    format_metric(avg_min_thigh, "°") if avg_min_thigh is not None else "N/A",
)
secondary[2].metric(
    "Avg elbow depth",
    format_metric(avg_min_elbow, "°") if avg_min_elbow is not None else "N/A",
)
secondary[3].metric(
    "Avg body angle",
    format_metric(avg_body, "°") if avg_body is not None else "N/A",
)

# Charts section
chart_col1, chart_col2 = st.columns(2)

if "verdict" in df.columns:
    verdict_counts = df["verdict"].value_counts().reset_index()
    verdict_counts.columns = ["verdict", "count"]
    fig = px.pie(
        verdict_counts,
        names="verdict",
        values="count",
        title="Rep verdict distribution",
        color_discrete_map={"good": "#2ecc71", "bad": "#e74c3c", "unknown": "#95a5a6"},
    )
    fig.update_traces(textinfo="percent+label")
    chart_col1.plotly_chart(fig, use_container_width=True)

if "view" in df.columns:
    view_counts = df["view"].value_counts().reset_index()
    view_counts.columns = ["view", "count"]
    fig2 = px.bar(
        view_counts,
        x="view",
        y="count",
        title="Camera view distribution",
        color="view",
        color_discrete_sequence=px.colors.qualitative.Set2,
    )
    fig2.update_layout(xaxis_title="View", yaxis_title="Reps")
    chart_col2.plotly_chart(fig2, use_container_width=True)

# Trend chart
trend_cols = st.columns(2)

if "rep" in df.columns:
    line_df = df.copy()
    if "min_knee_angle" in line_df.columns:
        metric_name = "min_knee_angle"
        metric_label = "Knee Angle"
    elif "min_elbow_angle" in line_df.columns:
        metric_name = "min_elbow_angle"
        metric_label = "Elbow Angle"
    else:
        metric_name = None

    if metric_name:
        trend_fig = px.line(
            line_df,
            x="rep",
            y=metric_name,
            title=f"{metric_label} across repetitions",
            markers=True,
        )
        trend_fig.update_layout(xaxis_title="Rep number", yaxis_title=f"{metric_label} (°)")
        trend_cols[0].plotly_chart(trend_fig, use_container_width=True)

    if "min_thigh_angle" in df.columns:
        thigh_fig = px.line(
            df,
            x="rep",
            y="min_thigh_angle",
            title="Minimum thigh angle across repetitions",
            markers=True,
        )
        thigh_fig.update_layout(xaxis_title="Rep number", yaxis_title="Thigh angle (°)")
        trend_cols[1].plotly_chart(thigh_fig, use_container_width=True)

# Detailed table
st.subheader("Rep-by-rep results")

table_df = df.copy()
for col in ["rep", "time_s", "min_knee_angle", "min_thigh_angle", "max_torso_lean", "min_elbow_angle", "worst_body_angle"]:
    if col in table_df.columns:
        table_df[col] = pd.to_numeric(table_df[col], errors="coerce")

if "issues" in table_df.columns:
    table_df["issues"] = table_df["issues"].fillna("-")

st.dataframe(table_df, use_container_width=True, hide_index=True)

# Sidebar quick details
st.sidebar.subheader("Insights")
if total_reps:
    st.sidebar.write(f"Total tracked reps: {total_reps}")
    st.sidebar.write(f"Good reps: {good_reps}")
    st.sidebar.write(f"Bad reps: {bad_reps}")
    st.sidebar.write(f"Success rate: {success_rate:.1f}%")
else:
    st.sidebar.write("No valid rep data yet.")

st.sidebar.markdown("---")
st.sidebar.caption("Tip: generate new rep logs from the exercise tracker and select them here.")
