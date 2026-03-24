/*
 * config.h for Emscripten WASM build of libdvdread + libdvdnav.
 * Provides the #defines that autotools would normally generate.
 */
#ifndef WEBDVD_WASM_CONFIG_H
#define WEBDVD_WASM_CONFIG_H

/* Disable libdvdcss (no encrypted disc support) */
/* HAVE_DVDCSS_DVDCSS_H is intentionally not defined */

/* dlopen: Emscripten provides dlfcn.h but dlopen returns NULL for
   nonexistent libraries, which is fine — dvdinput_setup will fall
   through to the file-based I/O path. */
#define HAVE_DLFCN_H 1

/* Standard headers available in Emscripten */
#define HAVE_LIMITS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_DIRENT_H 1
#define HAVE_SYS_PARAM_H 0

/* strerror_r availability */
#define HAVE_STRERROR_R 0

/* Unused attribute */
#ifndef UNUSED
#define UNUSED __attribute__((unused))
#endif

/* Byte-swap: Emscripten provides <byteswap.h> (musl), same as Linux.
   bswap.h checks for __linux__ || __GLIBC__ to use bswap_16/32/64. */

/* Version strings */
#define PACKAGE_VERSION "6.1.3-wasm"
#define VERSION "6.1.1-wasm"

/* DVDOpenFiles stub — the xbmc libdvdnav references this function but
   the xbmc libdvdread fork doesn't have it. We delegate to DVDOpen2. */
#include <dvdread/dvd_reader.h>
static inline dvd_reader_t *DVDOpenFiles(void *priv, const dvd_logger_cb *logcb,
                                          const char *path, void *fs) {
    (void)fs;
    return DVDOpen2(priv, logcb, path);
}

#endif /* WEBDVD_WASM_CONFIG_H */
