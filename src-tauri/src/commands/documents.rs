// Document parsing for uploaded resumes and job descriptions
// Supports: .txt, .md, .pdf (lopdf), .docx (zip + XML extraction)

use std::io::{Read, Cursor};

/// Parses raw file bytes into plain text based on file extension
#[tauri::command]
pub fn parse_document(file_bytes: Vec<u8>, file_name: String) -> Result<String, String> {
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "pdf" => extract_pdf(&file_bytes),
        "docx" => extract_docx(&file_bytes),
        "txt" | "md" | "" => {
            // Try UTF-8 first, then fall back to lossy conversion
            String::from_utf8(file_bytes.clone())
                .or_else(|_| Ok::<String, String>(String::from_utf8_lossy(&file_bytes).into_owned()))
                .map_err(|e: String| e)
        }
        _ => Err(format!("Unsupported file type: .{}", ext)),
    }
}

// PDF text extraction
fn sanitize_pdf_text(raw_text: &str) -> String {
    let lines: Vec<&str> = raw_text.split('\n').collect();
    let mut clean_lines = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Filter out PDF font/encoding/license stream metadata noise
        if trimmed == "Identity-H"
            || trimmed.contains("Identity-H")
            || trimmed.contains("FontDescriptor")
            || trimmed.contains("CIDInit")
            || trimmed.contains("ProcSet")
            || trimmed.contains("CMapName")
            || trimmed.contains("ToUnicode")
            || trimmed.contains("FontName")
            || trimmed.contains("FontFamily")
            || trimmed.contains("Adobe Systems")
            || trimmed.contains("SIL Open Font")
            || trimmed.contains("github.com")
            || trimmed.starts_with("/Type /Font")
            || trimmed.starts_with("/BaseFont")
            || trimmed.starts_with("/Subtype")
            || trimmed.starts_with("/Filter /FlateDecode")
            || trimmed.starts_with("/Length")
        {
            continue;
        }

        // Filter out unprintable control characters
        let clean_chars: String = trimmed
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();
        let clean_line = clean_chars.trim();

        if clean_line.len() >= 2 {
            clean_lines.push(clean_line.to_string());
        }
    }

    clean_lines.join("\n")
}

fn decode_pdf_hex_string(hex_str: &str) -> String {
    let clean_hex: String = hex_str.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean_hex.len() % 2 != 0 || clean_hex.is_empty() {
        return String::new();
    }

    let bytes: Vec<u8> = (0..clean_hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&clean_hex[i..i + 2], 16).ok())
        .collect();

    // 1. Try UTF-16BE decoding (standard for Identity-H CIDFonts)
    if bytes.len() >= 2 {
        let u16_words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        if let Ok(decoded) = String::from_utf16(&u16_words) {
            let clean: String = decoded.chars().filter(|c| !c.is_control() || *c == ' ').collect();
            let trimmed = clean.trim();
            if trimmed.len() >= 2 && trimmed.chars().any(|c| c.is_alphabetic()) {
                return trimmed.to_string();
            }
        }
    }

    // 2. Try UTF-8 / ASCII fallback
    if let Ok(decoded) = String::from_utf8(bytes.clone()) {
        let clean: String = decoded.chars().filter(|c| !c.is_control() || *c == ' ').collect();
        let trimmed = clean.trim();
        if trimmed.len() >= 2 && trimmed.chars().any(|c| c.is_alphabetic()) {
            return trimmed.to_string();
        }
    }

    String::new()
}

fn extract_pdf(bytes: &[u8]) -> Result<String, String> {
    use regex::Regex;

    // 1. Try pdf-extract first (specifically engineered for complex CMap / Identity-H encodings)
    if let Ok(extracted) = pdf_extract::extract_text_from_mem(bytes) {
        let sanitized = sanitize_pdf_text(&extracted);
        if sanitized.trim().split_whitespace().count() >= 15 {
            return Ok(sanitized);
        }
    }

    let mut all_words: Vec<String> = Vec::new();

    // 2. Try lopdf text extraction per page
    if let Ok(mut doc) = lopdf::Document::load_mem(bytes) {
        let _ = doc.decompress();

        let pages = doc.get_pages();
        let mut page_nums: Vec<u32> = pages.keys().cloned().collect();
        page_nums.sort();

        for page_num in page_nums {
            if let Ok(text) = doc.extract_text(&[page_num]) {
                let sanitized = sanitize_pdf_text(&text);
                if !sanitized.trim().is_empty() {
                    all_words.push(sanitized);
                }
            }
        }

        // 3. Fallback stream parser: if lopdf extract_text produced fewer than 20 words
        let current_word_count = all_words.join(" ").split_whitespace().count();
        if current_word_count < 20 {
            let paren_re = Regex::new(r"\(([^()]{2,})\)").unwrap();
            let hex_re = Regex::new(r"<([0-9a-fA-F]{4,})>").unwrap();

            for (_id, object) in doc.objects.iter() {
                if let Ok(content) = object.as_stream() {
                    let stream_bytes = content.decompressed_content().unwrap_or_else(|_| content.content.clone());
                    let stream_str = String::from_utf8_lossy(&stream_bytes);

                    // A) Parse parenthetical string literals (text)
                    for cap in paren_re.captures_iter(&stream_str) {
                        let text = cap[1].trim();
                        if text.len() >= 2
                            && !text.starts_with('/')
                            && !text.contains("Identity")
                            && !text.contains("Font")
                            && !text.contains("WinAnsi")
                            && !text.contains("Helvetica")
                            && !text.contains("Times")
                            && !text.contains("Arial")
                        {
                            let clean_chars: String = text
                                .chars()
                                .filter(|c| !c.is_control() || *c == ' ')
                                .collect();
                            let clean = clean_chars.trim();
                            if clean.len() >= 2 {
                                all_words.push(clean.to_string());
                            }
                        }
                    }

                    // B) Parse UTF-16BE hex string literals <00410042>
                    for cap in hex_re.captures_iter(&stream_str) {
                        let decoded = decode_pdf_hex_string(&cap[1]);
                        if !decoded.is_empty()
                            && !decoded.contains("Identity")
                            && !decoded.contains("Font")
                        {
                            all_words.push(decoded);
                        }
                    }
                }
            }
        }
    }

    let result = all_words.join("\n");
    let cleaned = sanitize_pdf_text(&result);

    if cleaned.trim().split_whitespace().count() < 3 {
        return Err("PDF contains no extractable text. If this is an image-only or scanned PDF, please paste your resume text directly into the text box.".to_string());
    }

    Ok(cleaned)
}

// DOCX text extraction
fn extract_docx(bytes: &[u8]) -> Result<String, String> {
    use zip::ZipArchive;
    use regex::Regex;

    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| format!("Failed to read DOCX (not a valid ZIP): {}", e))?;

    // The main document XML is always at word/document.xml
    let mut xml_content = String::new();
    {
        let mut file = archive.by_name("word/document.xml")
            .map_err(|_| "Could not find word/document.xml inside DOCX".to_string())?;
        file.read_to_string(&mut xml_content)
            .map_err(|e| format!("Failed to read document.xml: {}", e))?;
    }

    // Extract text from XML:
    // DOCX stores text in <w:t> tags. We extract those, then strip all remaining XML tags.
    // This is a lightweight approach that avoids a full XML parser dependency.
    let wt_re = Regex::new(r"<w:t[^>]*>([^<]*)</w:t>")
        .map_err(|e| e.to_string())?;
    
    // Also handle paragraph breaks (<w:p> tags) to insert newlines
    let para_re = Regex::new(r"</w:p>")
        .map_err(|e| e.to_string())?;

    // Insert newline markers at paragraph boundaries
    let with_newlines = para_re.replace_all(&xml_content, "\n");

    // Extract text from <w:t> tags
    let mut parts: Vec<String> = Vec::new();
    for cap in wt_re.captures_iter(&with_newlines) {
        let text = cap[1].trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }

    // Rejoin, collapsing multiple blank lines
    let raw = parts.join(" ");
    
    // Re-insert paragraph breaks properly
    let lines: Vec<&str> = raw.split('\n').collect();
    let cleaned: Vec<String> = lines
        .iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if cleaned.is_empty() {
        // Fallback: just strip all XML tags from the document
        let tag_re = Regex::new(r"<[^>]+>").map_err(|e| e.to_string())?;
        let plain = tag_re.replace_all(&xml_content, " ");
        let trimmed: String = plain.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            return Err("DOCX appears to be empty or contains no extractable text.".to_string());
        }
        return Ok(trimmed);
    }

    Ok(cleaned.join("\n"))
}

/// Saves uploaded document bytes to a temp directory and returns the path
#[tauri::command]
pub fn save_context_document(doc_type: String, file_name: String, file_bytes: Vec<u8>) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("Hackysack");
    dir.push("documents");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let clean_name = format!("{}_{}", doc_type, file_name.replace(' ', "_"));
    let file_path = dir.join(&clean_name);

    std::fs::write(&file_path, &file_bytes).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_file_path(file_path: String) -> Result<(), String> {
    let clean_path = file_path.trim().replace('/', "\\");
    if clean_path.is_empty() {
        return Err("File path is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Spawning explorer.exe directly with an absolute file path opens it in Windows default app
        let res = std::process::Command::new("explorer")
            .arg(&clean_path)
            .spawn();

        if res.is_err() {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "", &clean_path])
                .spawn();
        }
    }

    Ok(())
}

