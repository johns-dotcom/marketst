/**
 * Detect the MIME type of a Buffer by its magic bytes. Source of truth is the
 * actual content, not the filename — older uploads sometimes have a wrong or
 * missing extension (scanner software saving JPEGs as .pdf is a common case).
 * Returns null if the bytes don't match any recognized format.
 */
function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';        // %PDF
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';              // \x89PNG
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';                              // JPEG SOI
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';              // GIF8
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'; // RIFF…WEBP
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';                                                // BM
  return null;
}

module.exports = { sniffMime };
