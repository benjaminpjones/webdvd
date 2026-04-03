fn main() {
    println!("cargo::rustc-check-cfg=cfg(has_dvdread)");

    if let Ok(lib) = pkg_config::probe_library("dvdread") {
        for path in &lib.link_paths {
            println!("cargo:rustc-link-search=native={}", path.display());
        }
        println!("cargo:rustc-cfg=has_dvdread");
    } else {
        println!("cargo:warning=libdvdread not found; CSS decryption will be unavailable");
    }
}
