/**
 * Ed25519 signatures over a release manifest's exact bytes (ADR 0007), with
 * Node's built-in crypto and no other dependency. Keys are PEM text: a
 * private key as PKCS #8, a public key as SPKI, so `openssl` reads them too.
 * A signature is the 64 raw signature bytes in base64, on one line.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface ReleaseKeyPair {
  privateKey: string;
  publicKey: string;
}

/** A new key pair for signing releases. */
export function generateReleaseKeyPair(): ReleaseKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function ed25519(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${what} is not an Ed25519 key`);
  return key;
}

/** A public key from its PEM text; throws when the text is not an Ed25519 public key. */
export function parsePublicKey(pem: string): KeyObject {
  try {
    return ed25519(createPublicKey({ key: pem, format: "pem" }), "The public key");
  } catch (e) {
    throw new Error(`Not an Ed25519 public key: ${(e as Error).message}`, { cause: e });
  }
}

function parsePrivateKey(pem: string): KeyObject {
  try {
    return ed25519(createPrivateKey({ key: pem, format: "pem" }), "The signing key");
  } catch (e) {
    throw new Error(`Not an Ed25519 signing key: ${(e as Error).message}`, { cause: e });
  }
}

/** The public key that belongs to a signing key, as PEM text. */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(parsePrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
}

/** Whether two PEM texts hold the same public key, however they are wrapped. */
export function samePublicKey(a: string, b: string): boolean {
  const der = (pem: string) => parsePublicKey(pem).export({ type: "spki", format: "der" });
  return der(a).equals(der(b));
}

/** The signature file's text for these bytes. */
export function signBytes(bytes: Uint8Array, privateKeyPem: string): string {
  return sign(null, bytes, parsePrivateKey(privateKeyPem)).toString("base64") + "\n";
}

/** Whether a signature file's text is a valid signature of these bytes by any of these public keys. */
export function signedByAny(bytes: Uint8Array, signatureText: string, publicKeyPems: readonly string[]): boolean {
  const text = signatureText.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  const signature = Buffer.from(text, "base64");
  return publicKeyPems.some((pem) => verify(null, bytes, parsePublicKey(pem), signature));
}
