# Bundled PDF.js

- Package: `pdfjs-dist@6.4.299`, official npm distribution.
- Build: `legacy` library and viewer; matching core, worker and viewer versions.
- Download archive SHA-256: `86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415`.
- License: Apache-2.0, see `LICENSE` and the notices in each distributed resource directory.
- Source: https://github.com/mozilla/pdf.js
- Documentation: https://mozilla.github.io/pdf.js/

This directory is a local runtime dependency. No CDN scripts, build server or Node.js installation is needed to use the unpacked Chrome / Edge extension.

The extension uses its own reader UI, disables annotations and PDF scripting, and loads the bundled character maps, standard fonts, image decoders and ICC resources. Upgrading must replace the entire runtime with matching files and rerun the PDF extension tests.
