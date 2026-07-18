use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tower_http::cors::CorsLayer;

use crate::{
    AppState, auth, cache,
    disc::{Disc, Visibility},
    transcode,
};

/// Disc files (IFO/VOB sectors) are immutable for the life of a disc, so let
/// the browser cache them indefinitely. `private` keeps shared proxies from
/// serving cached bytes for access-gated discs to other users.
const DISC_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/library", get(library_list))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(auth_status))
        .route("/api/disc/{slug}/info", get(disc_info))
        .route(
            "/api/disc/{slug}/transcode/{titleset}",
            get(transcode_titleset),
        )
        .route("/api/disc/{slug}/ifo-list", get(ifo_list))
        .route("/api/disc/{slug}/ifo/{filename}", get(ifo_file))
        .route("/api/disc/{slug}/vob-list", get(vob_list))
        .route("/api/disc/{slug}/vob/{filename}", get(vob_file))
        .route("/api/disc/{slug}/vob-range/{filename}", get(vob_range))
        .route("/api/disc/{slug}/vob-size/{filename}", get(vob_size))
        .route("/api/disc/{slug}/menu-nav/{filename}", get(menu_nav))
        .route(
            "/api/disc/{slug}/transcode-menu/{titleset}",
            get(transcode_menu),
        )
        .route(
            "/api/disc/{slug}/title-file/{titleset}",
            get(title_file).head(title_file_head),
        )
        // TODO: /api/disc/{slug}/thumbnail — see GitHub issue for metadata/cover art
        .layer(CorsLayer::permissive())
        .with_state(state)
}

fn cookie_header(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::COOKIE).and_then(|v| v.to_str().ok())
}

fn is_authed(state: &AppState, headers: &HeaderMap) -> bool {
    state.auth.is_authed(cookie_header(headers))
}

/// Look up a disc and enforce visibility + auth: private discs require a
/// valid session cookie. Returns 404 (not 401/403) for unauthorized access
/// to private discs so an unauthenticated caller can't enumerate the
/// existence of private slugs.
fn require_access(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
) -> Result<Arc<Disc>, (StatusCode, String)> {
    let not_found = || (StatusCode::NOT_FOUND, format!("Disc not found: {slug}"));
    let disc = state
        .library
        .discs
        .get(slug)
        .cloned()
        .ok_or_else(not_found)?;
    if disc.visibility == Visibility::Private && !is_authed(state, headers) {
        return Err(not_found());
    }
    Ok(disc)
}

async fn library_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let show_all = is_authed(&state, &headers);
    let discs: Vec<serde_json::Value> = state
        .library
        .discs
        .iter()
        .filter(|(_, disc)| show_all || disc.visibility == Visibility::Public)
        .map(|(slug, disc)| {
            serde_json::json!({
                "slug": slug,
                "title": slug,
                "titlesets": disc.titlesets(),
                "vob_count": disc.vob_count(),
                "visibility": disc.visibility,
            })
        })
        .collect();
    Json(serde_json::json!({
        "discs": discs,
        "auth_enabled": state.auth.enabled(),
        "authenticated": show_all,
    }))
}

#[derive(serde::Deserialize)]
struct LoginRequest {
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !state.auth.check_password(&body.password) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid password".into()));
    }
    let Some(token) = state.auth.session_token() else {
        // Auth disabled — nothing to set. Return success so the UI flows the same.
        return Ok((HeaderMap::new(), Json(serde_json::json!({ "ok": true }))));
    };
    let cookie = format!(
        "{}={token}; HttpOnly; Path=/; Max-Age={}; SameSite=Lax",
        auth::COOKIE_NAME,
        auth::COOKIE_MAX_AGE_SECS,
    );
    let mut hdrs = HeaderMap::new();
    hdrs.insert(header::SET_COOKIE, cookie.parse().unwrap());
    Ok((hdrs, Json(serde_json::json!({ "ok": true }))))
}

async fn logout() -> impl IntoResponse {
    let cookie = format!(
        "{}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
        auth::COOKIE_NAME,
    );
    let mut hdrs = HeaderMap::new();
    hdrs.insert(header::SET_COOKIE, cookie.parse().unwrap());
    (hdrs, Json(serde_json::json!({ "ok": true })))
}

async fn auth_status(State(state): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "enabled": state.auth.enabled(),
        "authenticated": is_authed(&state, &headers),
    }))
}

async fn disc_info(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    Ok(Json(serde_json::json!({
        "path": disc.path.display().to_string(),
        "titlesets": disc.titlesets(),
        "vob_count": disc.vob_count(),
    })))
}

async fn ifo_list(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    Ok(Json(disc.ifo_files()))
}

async fn ifo_file(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    disc.video_ts_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("File not found: {filename}")))?;

    let fname = filename.clone();
    let bytes = tokio::task::spawn_blocking(move || disc.read_file(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, DISC_CACHE_CONTROL),
        ],
        bytes,
    ))
}

async fn vob_list(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    Ok(Json(disc.vob_files()))
}

async fn vob_file(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let bytes = tokio::task::spawn_blocking(move || disc.read_file(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, DISC_CACHE_CONTROL),
        ],
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
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let (data, total_size) =
        tokio::task::spawn_blocking(move || disc.read_vob_range(&fname, params.start, params.end))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        DISC_CACHE_CONTROL.parse().unwrap(),
    );
    headers.insert("x-vob-total-size", total_size.to_string().parse().unwrap());

    Ok((headers, data))
}

async fn vob_size(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let size = tokio::task::spawn_blocking(move || disc.vob_size(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({ "size": size })))
}

/// Sparse NAV-pack stream for a menu VOB: `[u32 LE sector][2048-byte NAV pack]`
/// repeated. Lets the client reconstruct navigation data without downloading
/// the menu video (see Disc::read_menu_nav).
async fn menu_nav(
    State(state): State<AppState>,
    Path((slug, filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    disc.vob_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("VOB not found: {filename}")))?;

    let fname = filename.clone();
    let data = tokio::task::spawn_blocking(move || disc.read_menu_nav(&fname))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, DISC_CACHE_CONTROL),
        ],
        data,
    ))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TranscodeParams {
    ss: Option<f64>,
    t: Option<f64>,
    sector: Option<u64>,
    last_sector: Option<u64>,
    /// `nocache=1` for ephemeral mid-title seek segments — stream without
    /// caching, so they don't accumulate overlapping per-sector tails on disk.
    nocache: Option<u8>,
}

/// Acquire a transcode-slot permit with timeout. Returns 503 if the queue
/// times out — cache hits should be checked BEFORE calling this so they
/// don't consume a slot.
async fn acquire_transcode_slot(
    state: &AppState,
) -> Result<tokio::sync::OwnedSemaphorePermit, (StatusCode, String)> {
    match tokio::time::timeout(
        state.transcode_queue_timeout,
        state.transcode_limit.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Transcode semaphore closed".into(),
        )),
        Err(_) => {
            tracing::warn!(
                "Transcode queue timeout after {:?} — all slots in use",
                state.transcode_queue_timeout,
            );
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Server busy — too many transcodes in flight. Try again in a few seconds.".into(),
            ))
        }
    }
}

fn cache_key(slug: &str, kind: cache::Kind, titleset: u32, p: &TranscodeParams) -> cache::CacheKey {
    cache::CacheKey {
        slug: slug.to_string(),
        kind,
        titleset,
        sector: p.sector,
        last_sector: p.last_sector,
        start_ms: cache::secs_to_ms(p.ss),
        duration_ms: cache::secs_to_ms(p.t),
    }
}

/// Transcode a menu VOB (titleset=0 for VMGM, N for VTS_N menu).
async fn transcode_menu(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    let key = cache_key(&slug, cache::Kind::Menu, titleset, &params);

    if let Some(body) = state.cache.serve_if_cached(&key).await {
        return Ok(([(axum::http::header::CONTENT_TYPE, "video/mp4")], body));
    }

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

    let permit = acquire_transcode_slot(&state).await?;

    let body = transcode::transcode_to_stream(
        &vobs,
        &opts,
        &disc,
        titleset,
        true,
        state.cache.clone(),
        key,
        permit,
        /* cache_output */ true,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(([(axum::http::header::CONTENT_TYPE, "video/mp4")], body))
}

/// Parse a single-range `Range: bytes=START-[END]` header. Suffix ranges
/// (`bytes=-N`) are unsupported (browsers use start-anchored ranges for video).
fn parse_byte_range(h: &str) -> Option<(u64, Option<u64>)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    let start: u64 = s.trim().parse().ok()?;
    let end = if e.trim().is_empty() {
        None
    } else {
        Some(e.trim().parse().ok()?)
    };
    Some((start, end))
}

/// Serve a fully-cached file with HTTP Range support so native `<video>` can
/// seek into it. Returns 206 for a satisfiable range, else 200 with the whole
/// file. Both advertise `Accept-Ranges: bytes`.
async fn serve_seekable_file(
    path: &std::path::Path,
    range: Option<&str>,
) -> Result<Response, (StatusCode, String)> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Title not fully cached".into()))?;
    let size = meta.len();
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let want = range.and_then(parse_byte_range).map(|(start, end)| {
        let last = size.saturating_sub(1);
        (start, end.unwrap_or(last).min(last))
    });

    if let Some((start, end)) = want {
        if start > end || start >= size {
            return Err((StatusCode::RANGE_NOT_SATISFIABLE, "Bad range".into()));
        }
        let len = end - start + 1;
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let stream = tokio_util::io::ReaderStream::new(file.take(len));
        let mut resp = Response::new(Body::from_stream(stream));
        *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
        let h = resp.headers_mut();
        h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
        h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
        h.insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}").parse().unwrap(),
        );
        h.insert(header::CACHE_CONTROL, DISC_CACHE_CONTROL.parse().unwrap());
        Ok(resp)
    } else {
        let stream = tokio_util::io::ReaderStream::new(file);
        let mut resp = Response::new(Body::from_stream(stream));
        let h = resp.headers_mut();
        h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
        h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
        h.insert(header::CONTENT_LENGTH, size.to_string().parse().unwrap());
        h.insert(header::CACHE_CONTROL, DISC_CACHE_CONTROL.parse().unwrap());
        Ok(resp)
    }
}

/// Serve the seekable (faststart) cache of a title with Range support. 404 if
/// the title hasn't been fully cached + remuxed yet (client falls back to the
/// streaming MSE path).
async fn title_file(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    require_access(&state, &slug, &headers)?;
    let key = cache_key(&slug, cache::Kind::Title, titleset, &params);
    let path = state.cache.seekable_path(&key);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    serve_seekable_file(&path, range).await
}

/// HEAD probe: 200 (+ size, Accept-Ranges) if the title is cached seekable,
/// else 404. The client uses this to choose native range playback vs. MSE.
async fn title_file_head(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    require_access(&state, &slug, &headers)?;
    let key = cache_key(&slug, cache::Kind::Title, titleset, &params);
    let path = state.cache.seekable_path(&key);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Title not fully cached".into()))?;
    let mut resp = Response::new(Body::empty());
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(
        header::CONTENT_LENGTH,
        meta.len().to_string().parse().unwrap(),
    );
    Ok(resp)
}

async fn transcode_titleset(
    State(state): State<AppState>,
    Path((slug, titleset)): Path<(String, u32)>,
    Query(params): Query<TranscodeParams>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let disc = require_access(&state, &slug, &headers)?;
    let key = cache_key(&slug, cache::Kind::Title, titleset, &params);

    if let Some(body) = state.cache.serve_if_cached(&key).await {
        return Ok(([(axum::http::header::CONTENT_TYPE, "video/mp4")], body));
    }

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

    let permit = acquire_transcode_slot(&state).await?;

    // Ephemeral mid-title seek segments aren't cached; only the canonical
    // from-start title transcode is (which then remuxes to a seekable file).
    let cache_output = params.nocache.unwrap_or(0) == 0;

    let body = transcode::transcode_to_stream(
        &vobs,
        &opts,
        &disc,
        titleset,
        false,
        state.cache.clone(),
        key,
        permit,
        cache_output,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(([(axum::http::header::CONTENT_TYPE, "video/mp4")], body))
}

#[cfg(test)]
mod tests {
    use super::parse_byte_range;

    #[test]
    fn parses_open_ended_range() {
        assert_eq!(parse_byte_range("bytes=1024-"), Some((1024, None)));
    }

    #[test]
    fn parses_closed_range() {
        assert_eq!(parse_byte_range("bytes=0-1023"), Some((0, Some(1023))));
    }

    #[test]
    fn tolerates_whitespace() {
        assert_eq!(parse_byte_range(" bytes=100-200 "), Some((100, Some(200))));
    }

    #[test]
    fn rejects_malformed_or_suffix_ranges() {
        assert_eq!(parse_byte_range("bytes=abc-"), None);
        assert_eq!(parse_byte_range("bytes=-500"), None); // suffix range unsupported
        assert_eq!(parse_byte_range("items=0-1"), None);
        assert_eq!(parse_byte_range("0-1"), None);
    }
}
