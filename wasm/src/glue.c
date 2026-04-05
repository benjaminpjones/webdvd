/*
 * glue.c — Thin C wrapper exposing libdvdnav functions to JavaScript via Emscripten.
 *
 * All exported functions use EMSCRIPTEN_KEEPALIVE and return simple types
 * (int, const char*) so they can be called via cwrap from TypeScript.
 */

#include <emscripten.h>
#include <dvdnav/dvdnav.h>
#include <dvdnav/dvdnav_events.h>
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <dvdread/ifo_types.h>
#include <dvdread/nav_types.h>
/* Internal header — needed to access position_current.cell_start
 * (VOB-absolute sector of the current cell) */
#include "vm/decoder.h"
#include "vm/vm.h"
#include "dvdnav_internal.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

static dvdnav_t *nav = NULL;
static char dvd_path[256] = {0};  /* stash disc path for IFO reads */

/* Pending menu cell info — when CELL_CHANGE fires in menu domain,
 * we stash it and continue looping to find the NAV_PACKET with buttons
 * (PCI isn't populated until a NAV pack is read). */
static int pending_menu_cell = 0;
static int pending_cell_n = 0;
static int pending_pg_n = 0;
static int pending_title = 0;
static int pending_part = 0;
static long long pending_pgc_length_ms = 0;
static long long pending_cell_start_ms = 0;

/* Last NAV packet's VOBU start PTS (90kHz clock, VOB-absolute).
 * Used by JS to compute seek time into the menu VOB. */
static uint32_t last_vobu_start_ptm = 0;

/* --- Lifecycle --- */

EMSCRIPTEN_KEEPALIVE
int dvd_open(const char *path) {
    if (nav) dvdnav_close(nav);
    nav = NULL;
    snprintf(dvd_path, sizeof(dvd_path), "%s", path);
    dvdnav_status_t status = dvdnav_open(&nav, path);
    if (status != DVDNAV_STATUS_OK) {
        nav = NULL;
        return -1;
    }
    /* Disable read-ahead cache — we discard MPEG-2 data anyway */
    dvdnav_set_readahead_flag(nav, 0);
    /* Set region mask to all regions */
    dvdnav_set_region_mask(nav, 0xFF);
    /* Enable PGC-based positioning for accurate time reporting */
    dvdnav_set_PGC_positioning_flag(nav, 1);
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

/* --- Navigation (starts the VM) --- */

EMSCRIPTEN_KEEPALIVE
int dvd_title_play(int title) {
    if (!nav) return -1;
    return dvdnav_title_play(nav, title) == DVDNAV_STATUS_OK ? 0 : -1;
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

/* --- VM Navigation (M2) --- */

EMSCRIPTEN_KEEPALIVE
int dvd_still_skip(void) {
    if (!nav) return -1;
    return dvdnav_still_skip(nav) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_wait_skip(void) {
    if (!nav) return -1;
    return dvdnav_wait_skip(nav) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_part_play(int title, int part) {
    if (!nav) return -1;
    return dvdnav_part_play(nav, title, part) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_current_title(void) {
    if (!nav) return -1;
    int32_t title = 0, part = 0;
    if (dvdnav_current_title_info(nav, &title, &part) != DVDNAV_STATUS_OK)
        return -1;
    return title;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_current_part(void) {
    if (!nav) return -1;
    int32_t title = 0, part = 0;
    if (dvdnav_current_title_info(nav, &title, &part) != DVDNAV_STATUS_OK)
        return -1;
    return part;
}

EMSCRIPTEN_KEEPALIVE
int dvd_is_domain_vts(void) {
    if (!nav) return 0;
    return dvdnav_is_domain_vts(nav) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int dvd_is_domain_menu(void) {
    if (!nav) return 0;
    return (dvdnav_is_domain_vmgm(nav) || dvdnav_is_domain_vtsm(nav)) ? 1 : 0;
}

/*
 * dvd_get_next_event() — Core M2 function.
 *
 * Loops dvdnav_get_next_block() internally, skipping BLOCK_OK / NAV_PACKET / NOP
 * (discarding MPEG-2 data). Returns JSON string on the first "interesting" event.
 * Has an iteration cap to avoid infinite WASM hangs.
 *
 * Returned JSON always has "event" (int). Additional fields depend on event type.
 */
static char event_buf[2048];  /* for dvdnav_get_next_block */

static char json_buf[16384];

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_next_event(void) {
    if (!nav) return "{\"event\":-1,\"error\":\"not open\"}";

    int32_t event = 0;
    int32_t len = 0;
    int iterations = 0;
    const int MAX_ITER = 500000;
    double start_time = emscripten_get_now();

    while (iterations++ < MAX_ITER) {
        /* Time-based bailout — don't block JS thread for more than 100ms */
        if (iterations % 2000 == 0 &&
            emscripten_get_now() - start_time > 100.0) {
            break;
        }

        dvdnav_status_t status = dvdnav_get_next_block(nav,
            (uint8_t*)event_buf, &event, &len);

        if (status != DVDNAV_STATUS_OK) {
            pending_menu_cell = 0;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":-1,\"error\":\"%s\"}", dvdnav_err_to_string(nav));
            return json_buf;
        }

        switch (event) {
        case DVDNAV_BLOCK_OK:
        case DVDNAV_NOP:
            /* Skip — discard MPEG-2 data, continue spinning */
            continue;

        case DVDNAV_NAV_PACKET: {
            /* NAV packs populate PCI (button data for menus) as a
             * side effect of dvdnav_get_next_block(). We skip the event
             * itself — menu detection happens via STILL_FRAME/HIGHLIGHT
             * which fire after PCI is populated. */
            pci_t *nav_pci = dvdnav_get_current_nav_pci(nav);
            if (nav_pci) {
                last_vobu_start_ptm = nav_pci->pci_gi.vobu_s_ptm;
            }
            continue;
        }

        case DVDNAV_CELL_CHANGE: {
            dvdnav_cell_change_event_t *cell =
                (dvdnav_cell_change_event_t*)event_buf;
            int32_t title = 0, part = 0;
            dvdnav_current_title_info(nav, &title, &part);
            int is_vts = dvdnav_is_domain_vts(nav) ? 1 : 0;

            /* Get VOB-absolute first sector of this cell from the PGC
             * cell playback table. cell_start in the event struct is
             * PGC-relative (sum of preceding cells' sectors). */
            dvd_state_t *state = &nav->vm->state;
            uint32_t first_sector = 0;
            uint32_t last_sector = 0;
            uint32_t pgc_last_sector = 0;
            if (state->pgc && cell->cellN > 0 &&
                cell->cellN <= state->pgc->nr_of_cells) {
                first_sector = state->pgc->cell_playback[cell->cellN - 1].first_sector;
                last_sector = state->pgc->cell_playback[cell->cellN - 1].last_sector;
                /* PGC-level last sector: the last sector of the final cell
                 * in this PGC. Used to bound title playback so the server
                 * doesn't read past the title into adjacent content. */
                pgc_last_sector = state->pgc->cell_playback[state->pgc->nr_of_cells - 1].last_sector;
            }

            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":6,\"cellN\":%d,\"pgN\":%d,"
                "\"pgcLengthMs\":%lld,\"cellStartSectors\":%lld,"
                "\"firstSector\":%u,\"lastSector\":%u,"
                "\"pgcLastSector\":%u,"
                "\"title\":%d,\"part\":%d,\"isVts\":%d}",
                cell->cellN, cell->pgN,
                (long long)(cell->pgc_length / 90),
                (long long)(cell->cell_start),
                (unsigned)first_sector, (unsigned)last_sector,
                (unsigned)pgc_last_sector,
                (int)title, (int)part, is_vts);
            return json_buf;
        }

        case DVDNAV_VTS_CHANGE: {
            dvdnav_vts_change_event_t *vts =
                (dvdnav_vts_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":5,\"oldVtsN\":%d,\"newVtsN\":%d,"
                "\"oldDomain\":%d,\"newDomain\":%d}",
                vts->old_vtsN, vts->new_vtsN,
                (int)vts->old_domain, (int)vts->new_domain);
            return json_buf;
        }

        case DVDNAV_STILL_FRAME: {
            dvdnav_still_event_t *still =
                (dvdnav_still_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":2,\"stillLength\":%d}", still->length);
            return json_buf;
        }

        case DVDNAV_WAIT:
            /* No internal FIFO to drain — skip immediately and continue */
            dvdnav_wait_skip(nav);
            continue;

        case DVDNAV_STOP:
            return "{\"event\":8}";

        case DVDNAV_HOP_CHANNEL:
            return "{\"event\":12}";

        case DVDNAV_SPU_STREAM_CHANGE: {
            dvdnav_spu_stream_change_event_t *spu =
                (dvdnav_spu_stream_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":3,\"physicalWide\":%d,\"physicalLetterbox\":%d,"
                "\"physicalPanScan\":%d,\"logical\":%d}",
                spu->physical_wide, spu->physical_letterbox,
                spu->physical_pan_scan, spu->logical);
            return json_buf;
        }

        case DVDNAV_AUDIO_STREAM_CHANGE: {
            dvdnav_audio_stream_change_event_t *audio =
                (dvdnav_audio_stream_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":4,\"physical\":%d,\"logical\":%d}",
                audio->physical, audio->logical);
            return json_buf;
        }

        case DVDNAV_SPU_CLUT_CHANGE: {
            /* Colour lookup table — 16 entries of {0, Y, Cr, Cb} */
            uint32_t *clut = (uint32_t*)event_buf;
            int pos = 0;
            pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
                "{\"event\":10,\"clut\":[");
            for (int i = 0; i < 16 && pos < (int)sizeof(json_buf) - 32; i++) {
                if (i > 0) json_buf[pos++] = ',';
                pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
                    "%u", (unsigned)clut[i]);
            }
            pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");
            return json_buf;
        }

        case DVDNAV_HIGHLIGHT: {
            dvdnav_highlight_event_t *hl =
                (dvdnav_highlight_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":9,\"display\":%d,\"buttonN\":%u,"
                "\"palette\":%u,\"sx\":%u,\"sy\":%u,\"ex\":%u,\"ey\":%u}",
                hl->display, (unsigned)hl->buttonN,
                (unsigned)hl->palette,
                (unsigned)hl->sx, (unsigned)hl->sy,
                (unsigned)hl->ex, (unsigned)hl->ey);
            return json_buf;
        }

        default:
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":%d}", event);
            return json_buf;
        }
    }

    /* Safety valve — yielded after MAX_ITER or time limit without an interesting event */
    pending_menu_cell = 0;
    return "{\"event\":-2,\"error\":\"iteration limit\"}";
}

EMSCRIPTEN_KEEPALIVE
unsigned dvd_get_last_vobu_ptm(void) {
    return last_vobu_start_ptm;
}

/* --- Menu / Button Interaction (M3) --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_current_button(void) {
    if (!nav) return 0;
    int32_t btn = 0;
    dvdnav_get_current_highlight(nav, &btn);
    return btn;
}

/*
 * dvd_get_buttons() — return JSON array of all valid buttons in the current PCI.
 * Each entry has: buttonN, x0, y0, x1, y1, up, down, left, right, auto_action.
 * Returns "[]" if no buttons or no PCI available.
 */
EMSCRIPTEN_KEEPALIVE
const char* dvd_get_buttons(void) {
    if (!nav) return "[]";
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return "[]";

    int num_buttons = pci->hli.hl_gi.btn_ns;
    if (num_buttons <= 0 || num_buttons > 36) return "[]";

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "[");
    for (int i = 0; i < num_buttons && pos < (int)sizeof(json_buf) - 200; i++) {
        btni_t *btn = &pci->hli.btnit[i];
        if (i > 0) json_buf[pos++] = ',';
        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "{\"buttonN\":%d,\"x0\":%u,\"y0\":%u,\"x1\":%u,\"y1\":%u,"
            "\"up\":%u,\"down\":%u,\"left\":%u,\"right\":%u,\"auto\":%u,"
            "\"btnColn\":%u}",
            i + 1,
            (unsigned)btn->x_start, (unsigned)btn->y_start,
            (unsigned)btn->x_end, (unsigned)btn->y_end,
            (unsigned)btn->up, (unsigned)btn->down,
            (unsigned)btn->left, (unsigned)btn->right,
            (unsigned)btn->auto_action_mode,
            (unsigned)btn->btn_coln);
    }
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]");
    return json_buf;
}

/*
 * dvd_get_button_colors() — return the PCI button color table (btn_colit).
 * 3 color groups × 2 states (select, action) = 6 uint32 values.
 * Each uint32 encodes [Ci3:4, Ci2:4, Ci1:4, Ci0:4, A3:4, A2:4, A1:4, A0:4]
 * where Ci = CLUT index, A = alpha (0=transparent, 15=opaque).
 */
EMSCRIPTEN_KEEPALIVE
const char* dvd_get_button_colors(void) {
    if (!nav) return "[]";
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return "[]";

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "[");
    for (int g = 0; g < 3; g++) {
        if (g > 0) json_buf[pos++] = ',';
        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "[%u,%u]",
            (unsigned)pci->hli.btn_colit.btn_coli[g][0],
            (unsigned)pci->hli.btn_colit.btn_coli[g][1]);
    }
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]");
    return json_buf;
}

EMSCRIPTEN_KEEPALIVE
int dvd_button_activate(void) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_button_activate(nav, pci) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_button_select_up(void) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_upper_button_select(nav, pci) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_button_select_down(void) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_lower_button_select(nav, pci) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_button_select_left(void) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_left_button_select(nav, pci) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_button_select_right(void) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_right_button_select(nav, pci) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_mouse_select(int x, int y) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_mouse_select(nav, pci, x, y) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_mouse_activate(int x, int y) {
    if (!nav) return -1;
    pci_t *pci = dvdnav_get_current_nav_pci(nav);
    if (!pci) return -1;
    return dvdnav_mouse_activate(nav, pci, x, y) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_menu_call(int menu_id) {
    if (!nav) return -1;
    return dvdnav_menu_call(nav, (DVDMenuID_t)menu_id) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_go_up(void) {
    if (!nav) return -1;
    return dvdnav_go_up(nav) == DVDNAV_STATUS_OK ? 0 : -1;
}

/* --- Chapter duration info (returns JSON string) --- */

EMSCRIPTEN_KEEPALIVE
const char* dvd_describe_title(int title) {
    if (!nav) return "{}";
    uint64_t *times = NULL;
    uint64_t duration = 0;
    uint32_t n = dvdnav_describe_title_chapters(nav, title, &times, &duration);

    /* Get VTS number from the VMGM title table (tt_srpt).
     * We open the VMGM IFO directly via libdvdread to avoid
     * depending on internal libdvdnav headers. */
    int vts = 0;
    int vts_ttn = 0;
    uint32_t pgc_first_sector = 0;
    uint32_t pgc_last_sector = 0;
    if (dvd_path[0]) {
        dvd_reader_t *reader = DVDOpen(dvd_path);
        if (reader) {
            ifo_handle_t *vmgi = ifoOpen(reader, 0);
            if (vmgi && vmgi->tt_srpt && title >= 1 &&
                title <= (int)vmgi->tt_srpt->nr_of_srpts) {
                vts = vmgi->tt_srpt->title[title - 1].title_set_nr;
                vts_ttn = vmgi->tt_srpt->title[title - 1].vts_ttn;
            }
            if (vmgi) ifoClose(vmgi);

            /* Look up PGC sector bounds from VTS IFO */
            if (vts > 0 && vts_ttn > 0) {
                ifo_handle_t *vtsi = ifoOpen(reader, vts);
                if (vtsi && vtsi->vts_pgcit) {
                    /* Map vts_ttn to PGC number via VTS_PTT_SRPT */
                    int pgcN = vts_ttn; /* default: PGC N = ttn */
                    if (vtsi->vts_ptt_srpt && vts_ttn >= 1 &&
                        vts_ttn <= (int)vtsi->vts_ptt_srpt->nr_of_srpts) {
                        pgcN = vtsi->vts_ptt_srpt->title[vts_ttn - 1].ptt[0].pgcn;
                    }
                    if (pgcN >= 1 && pgcN <= (int)vtsi->vts_pgcit->nr_of_pgci_srp) {
                        pgc_t *pgc = vtsi->vts_pgcit->pgci_srp[pgcN - 1].pgc;
                        if (pgc && pgc->nr_of_cells > 0) {
                            pgc_first_sector = pgc->cell_playback[0].first_sector;
                            pgc_last_sector = pgc->cell_playback[pgc->nr_of_cells - 1].last_sector;
                        }
                    }
                }
                if (vtsi) ifoClose(vtsi);
            }
            DVDClose(reader);
        }
    }

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
        "{\"chapters\":%u,\"duration_ms\":%llu,\"vts\":%d,\"vts_ttn\":%d,"
        "\"firstSector\":%u,\"lastSector\":%u,"
        "\"chapter_times_ms\":[",
        (unsigned)n, (unsigned long long)(duration / 90), vts, vts_ttn,
        (unsigned)pgc_first_sector, (unsigned)pgc_last_sector);

    for (uint32_t i = 0; i < n && pos < (int)sizeof(json_buf) - 32; i++) {
        if (i > 0) json_buf[pos++] = ',';
        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "%llu", (unsigned long long)(times[i] / 90));
    }
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");

    if (times) free(times);
    return json_buf;
}
