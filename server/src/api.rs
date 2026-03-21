use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
};
use tower_http::cors::CorsLayer;

use crate::{AppState, transcode};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/disc", get(disc_info))
        .route("/api/transcode/{titleset}", get(transcode_titleset))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn disc_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    let titlesets = state.disc.titlesets();
    Json(serde_json::json!({
        "path": state.disc.path.display().to_string(),
        "titlesets": titlesets,
        "vob_count": state.disc.vob_count(),
    }))
}

async fn transcode_titleset(
    State(state): State<AppState>,
    Path(titleset): Path<u32>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let vobs = state.disc.vobs_for_titleset(titleset);
    if vobs.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No VOBs found for title set {titleset}"),
        ));
    }

    let mp4_bytes = transcode::transcode_to_mp4(&vobs)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "video/mp4")],
        mp4_bytes,
    ))
}
