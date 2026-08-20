// ============================================================
// src/utils/crypto.ts — LOCAL SECRET ENCRYPTION UTILITY
// ============================================================
// Encrypts sensitive credentials before writing to disk (localStorage)
// so keys never sit in plain text on the user's filesystem.

const CIPHER_PREFIX = "enc_v1_";
const SALT = "HackySack_v1_Secret_Salt_2026";

/**
 * Encrypts a plain-text secret string into an obfuscated ciphertext payload.
 */
export function encryptSecret(plainText: string): string {
  if (!plainText || plainText.startsWith(CIPHER_PREFIX)) {
    return plainText;
  }
  try {
    const textChars = Array.from(plainText);
    const saltChars = Array.from(SALT);
    const obfuscated = textChars.map((char, index) => {
      const charCode = char.charCodeAt(0);
      const saltCode = saltChars[index % saltChars.length].charCodeAt(0);
      return String.fromCharCode(charCode ^ saltCode);
    }).join("");
    return `${CIPHER_PREFIX}${btoa(obfuscated)}`;
  } catch (err) {
    console.error("Failed to encrypt secret:", err);
    return plainText;
  }
}

/**
 * Decrypts a ciphertext payload back into a plain-text secret string.
 * Handles legacy unencrypted plain-text strings seamlessly.
 */
export function decryptSecret(cipherText: string | null): string {
  if (!cipherText) return "";
  if (!cipherText.startsWith(CIPHER_PREFIX)) {
    return cipherText; // Legacy plain-text fallback
  }
  try {
    const base64Str = cipherText.slice(CIPHER_PREFIX.length);
    let obfuscated: string;
    try {
      obfuscated = decodeURIComponent(atob(base64Str));
    } catch {
      obfuscated = atob(base64Str);
    }
    const obfuscatedChars = Array.from(obfuscated);
    const saltChars = Array.from(SALT);
    const decrypted = obfuscatedChars.map((char, index) => {
      const charCode = char.charCodeAt(0);
      const saltCode = saltChars[index % saltChars.length].charCodeAt(0);
      return String.fromCharCode(charCode ^ saltCode);
    }).join("");
    return decrypted;
  } catch (err) {
    console.error("Failed to decrypt secret:", err);
    return "";
  }
}
