#ifndef LIBDVDNAV_VERSION_H
#define LIBDVDNAV_VERSION_H

#define DVDNAV_VERSION_CODE(major, minor, micro) \
     (((major) * 10000) +                         \
      ((minor) *   100) +                         \
      ((micro) *     1))

#define DVDNAV_VERSION_MAJOR 6
#define DVDNAV_VERSION_MINOR 1
#define DVDNAV_VERSION_MICRO 1

#define DVDNAV_VERSION_STRING "6.1.1"

#define DVDNAV_VERSION \
    DVDNAV_VERSION_CODE(DVDNAV_VERSION_MAJOR, DVDNAV_VERSION_MINOR, DVDNAV_VERSION_MICRO)

#endif
