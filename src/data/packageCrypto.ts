/**
 * packageCrypto.ts
 *
 * Cifrado/descifrado AES-256-GCM de paquetes .examcoach.zip
 * Usa Web Crypto API (funciona en browser y Node 20+).
 *
 * Formato del archivo .enc:
 *   [16 bytes salt][12 bytes IV][N bytes ciphertext + GCM tag]
 */

const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 100_000;

/** Deriva una clave AES-256 a partir de una contraseña y un salt */
async function deriveKey(password: string, salt: BufferSource): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Cifra un ArrayBuffer con AES-256-GCM. Devuelve salt+iv+ciphertext. */
export async function encryptPackage(
  data: ArrayBuffer,
  password: string,
): Promise<ArrayBuffer> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  );

  // Concatenar: salt + iv + ciphertext
  const result = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LEN);
  result.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return result.buffer;
}

/** Descifra un ArrayBuffer (salt+iv+ciphertext) con AES-256-GCM. */
export async function decryptPackage(
  encData: ArrayBuffer,
  password: string,
): Promise<ArrayBuffer> {
  const buf = new Uint8Array(encData);
  const salt = buf.slice(0, SALT_LEN);
  const iv = buf.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = buf.slice(SALT_LEN + IV_LEN);

  const key = await deriveKey(password, salt);

  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
  } catch {
    throw new Error('Contraseña incorrecta');
  }
}
