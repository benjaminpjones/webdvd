use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
};
use tower_http::cors::CorsLayer;

use crate::{AppState, disc::Disc, transcode};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/library", get(library_list))
        .route("/api/disc/{slug}/info", get(disc_info))
        .route("/api/disc/{slug}/transcode/{titleset}", get(transcode_titleset))
        .route("/api/disc/{slug}/ifo-list", get(ifo_list))
        .route("/api/disc/{slug}/ifo/{filename}", get(ifo_file))
        .route("/api/disc/{slug}/vob-list", get(vob_list))
        .route("/api/disc/{slug}/vob/{filename}", get(vob_file))
        .route("/api/disc/{slug}/vob-range/{filename}", get(vob_range))
        .route("/api/disc/{slug}/vob-size/{filename}", get(vob_size))
        .route("/api/disc/{slug}/transcode-menu/{titleset}", get(transcode_menu))
        // TODO: /api/disc/{slug}/thumbnail — see GitHub issue for metadata/cover art
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Helper to look up a disc by slug, returning 404 if not found.
fn get_disc(state: &AppState, slug: &str) -> Result<Arc<Disc>, (StatusCode, String)> {
    state
        .library
        .discs
        .get(slug)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Disc not found: {slug}")))
}

async fn library_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let discs: Vec<serde_json::Value> = state
        .library
        .discs
        .iter()
        .map(|(slug, disc)| {
            serde_json::json!({
                "slug": slug,
                "title": slug,
                "titlesets": disc.titlesets(),
                "vob_count": disc.vob_count(),
            })
        })
        .collect();
    Json(serde_json::json!({ "discs": discs }))
}

async fn disc_info(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    Ok(Json(serde_json::json!({
        "path": disc.path.display().to_string(),
        "titlesets": disc.titlesets(),
        "vob_count": disc.vob_count(),
    })))
}

async fn ifo_list(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    Ok(Json(disc.ifo_files()))
}

async fn ifo_file(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    disc.video_ts_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("File not found: {filename}")))?;

    let fname = filename.clone();
    let bytes = tokio::task::spawn_blocking(move || disc.read_file(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    ))
}

async fn vob_list(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    Ok(Json(disc.vob_files()))
}

async fn vob_file(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let bytes = tokio::task::spawn_blocking(move || disc.read_file(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    ))
}

#[derive(serde::Deserialize)]
struct VobRangeParams {
    start: u64,
    end: u64,
}

async fn vob_range(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
    Query(params): Query<VobRangeParams>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let (data, total_size) = tokio::task::spawn_blocking(move || {
        disc.read_vob_range(&fname, params.start, params.end)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(axum::http::header::CONTENT_TYPE, "application/octet-stream".parse().unwrap());
    headers.insert("x-vob-total-size", total_size.to_string().parse().unwrap());

    Ok((headers, data))
}

async fn vob_size(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let size = tokio::task::spawn_blocking(move || disc.vob_size(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({ "size": size })))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TranscodeParams {
    ss: Option<f64>,
    t: Option<f64>,
    sector: Option<u64>,
    last_sector: Option<u64>,
}

/// Transcode a menu VOB (titleset=0 for VMGM, N for VTS_N menu).
async fn transcode_menu(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    let vobs = disc.menu_vobs(titleset);
    if vobs.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No menu VOBs found for titleset {titleset}"),
        ));
    }

    let opts = transcode::TranscodeOpts {
        start_secs: params.ss,
        duration_secs: params.t,
        sector: params.sector,
        last_sector: params.last_sector,
    };

    let body = transcode::transcode_to_stream(&vobs, &opts, &disc, titleset, true)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "video/mp4")],
        body,
    ))
}

async fn transcode_titleset(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = get_disc(&state, &slug)?;
    let vobs = disc.vobs_for_titleset(titleset);
    if vobs.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No VOBs found for title set {titleset}"),
        ));
    }

    let opts = transcode::TranscodeOpts {
        start_secs: params.ss,
        duration_secs: params.t,
        sector: params.sector,
        last_sector: params.last_sector,
    };

    let body = transcode::transcode_to_stream(&vobs, &opts, &disc, titleset, false)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "video/mp4")],
        body,
    ))
}

