/*
 * glue.c — Thin C wrapper exposing libdvdnav functions to JavaScript via Emscripten.
 *
 * All exported functions use EMSCRIPTEN_KEEPALIVE and return simple types
 * (int, const char*) so they can be called via cwrap from TypeScript.
 */

#include <emscripten.h>
#include <dvdnav/dvdnav.h>
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <dvdread/ifo_types.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

static dvdnav_t *nav = NULL;

/* --- Lifecycle --- */

EMSCRIPTEN_KEEPALIVE
int dvd_open(const char *path) {
    if (nav) dvdnav_close(nav);
    nav = NULL;
    dvdnav_status_t status = dvdnav_open(&nav, path);
    if (status != DVDNAV_STATUS_OK) {
        nav = NULL;
        return -1;
    }
    /* Disable read-ahead cache — we only query structure in M1 */
    dvdnav_set_readahead_flag(nav, 0);
    /* Set region mask to all regions */
    dvdnav_set_region_mask(nav, 0xFF);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void dvd_close(void) {
    if (nav) { dvdnav_close(nav); nav = NULL; }
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_error(void) {
    if (!nav) return "not open";
    return dvdnav_err_to_string(nav);
}

/* --- Title/Chapter Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_titles(void) {
    int32_t titles = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_titles(nav, &titles) != DVDNAV_STATUS_OK)
        return -1;
    return titles;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_parts(int title) {
    int32_t parts = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_parts(nav, title, &parts) != DVDNAV_STATUS_OK)
        return -1;
    return parts;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_angles(int title) {
    int32_t angles = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_angles(nav, title, &angles) != DVDNAV_STATUS_OK)
        return -1;
    return angles;
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_title_string(void) {
    const char *str = NULL;
    if (!nav) return "";
    dvdnav_get_title_string(nav, &str);
    return str ? str : "";
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_serial_string(void) {
    const char *str = NULL;
    if (!nav) return "";
    dvdnav_get_serial_string(nav, &str);
    return str ? str : "";
}

/* --- Video Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_aspect(void) {
    if (!nav) return -1;
    return dvdnav_get_video_aspect(nav);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_width(void) {
    uint32_t w = 0, h = 0;
    if (!nav) return -1;
    dvdnav_get_video_resolution(nav, &w, &h);
    return (int)w;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_height(void) {
    uint32_t w = 0, h = 0;
    if (!nav) return -1;
    dvdnav_get_video_resolution(nav, &w, &h);
    return (int)h;
}

/* --- Audio Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_audio_streams(void) {
    if (!nav) return -1;
    return dvdnav_get_number_of_streams(nav, DVD_AUDIO_STREAM);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_lang(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_to_lang(nav, (uint8_t)stream);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_channels(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_channels(nav, (uint8_t)stream);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_format(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_format(nav, (uint8_t)stream);
}

/* --- Subpicture Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_spu_streams(void) {
    if (!nav) return -1;
    return dvdnav_get_number_of_streams(nav, DVD_SUBTITLE_STREAM);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_spu_lang(int stream) {
    if (!nav) return 0;
    return dvdnav_spu_stream_to_lang(nav, (uint8_t)stream);
}

/* --- Chapter duration info (returns JSON string) --- */

static char json_buf[16384];

EMSCRIPTEN_KEEPALIVE
const char* dvd_describe_title(int title) {
    if (!nav) return "{}";
    uint64_t *times = NULL;
    uint64_t duration = 0;
    uint32_t n = dvdnav_describe_title_chapters(nav, title, &times, &duration);

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
        "{\"chapters\":%u,\"duration_ms\":%llu,\"chapter_times_ms\":[",
        (unsigned)n, (unsigned long long)(duration / 90));

    for (uint32_t i = 0; i < n && pos < (int)sizeof(json_buf) - 32; i++) {
        if (i > 0) json_buf[pos++] = ',';
        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "%llu", (unsigned long long)(times[i] / 90));
    }
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");

    if (times) free(times);
    return json_buf;
}
