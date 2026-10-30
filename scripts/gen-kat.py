#!/usr/bin/env python3
"""Generate KNOWN-ANSWER-TEST vectors for the Calendar PoC crypto, using ONLY
Python's hashlib/hmac + pycryptodome — an implementation INDEPENDENT of both
the browser WebCrypto path and the Node crypto mirror.

Output: JSON literals hardcoded into test/crypto-parity.mjs.
Construction (PROTOCOL v4.1 §3/§6/§8, WORKLOG D2/D3):
  KEK     = PBKDF2-HMAC-SHA256(password, salt16, 100000, 32)
  wrapped = AES-256-GCM(KEK, nonce12, AES1) -> nonce(12) || ct(32) || tag(16)
  subkey  = HKDF-SHA256(ikm=AES1, salt="", info="clock-v4/<domain>", 32)
  AAD     = utf8(id) || u32be(ver)
"""
import hashlib
import hmac
import json

from Crypto.Cipher import AES

PASSWORD = "kat-password-0123456789"
SALT = bytes.fromhex("00112233445566778899aabbccddeeff")
AES1 = bytes(range(32))
ITERS = 100000


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    # RFC 5869 extract+expand (independent of any HKDF library helper).
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    t = b""
    okm = b""
    i = 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]


kek = hashlib.pbkdf2_hmac("sha256", PASSWORD.encode(), SALT, ITERS, dklen=32)
nonce = bytes.fromhex("0102030405060708090a0b0c")
cipher = AES.new(kek, AES.MODE_GCM, nonce=nonce, mac_len=16)
ct, tag = cipher.encrypt_and_digest(AES1)
wrapped = nonce + ct + tag  # 12 + 32 + 16 = 60

kat = {
    "password": PASSWORD,
    "salt_hex": SALT.hex(),
    "iters": ITERS,
    "aes1_hex": AES1.hex(),
    "kek_hex": kek.hex(),
    "wrapped_hex": wrapped.hex(),
    "k_data_hex": hkdf_sha256(AES1, b"", b"clock-v4/K_data", 32).hex(),
    "auth_ui_hex": hkdf_sha256(AES1, b"", b"clock-v4/AUTH_UI", 32).hex(),
    "auth_clock_hex": hkdf_sha256(AES1, b"", b"clock-v4/AUTH_CLOCK", 32).hex(),
    # AAD KAT: id "cal:20261030" (pure ASCII), ver 7 -> utf8(id) || u32be(7)
    "aad_id": "cal:20261030",
    "aad_ver": 7,
    "aad_hex": ("cal:20261030".encode("utf-8") + (7).to_bytes(4, "big")).hex(),
    # Unicode AAD KAT (UTF-8 bytes — both implementations use UTF-8):
    "aad_unicode_id": "cal:\U0001f384",
    "aad_unicode_hex": ("cal:\U0001f384".encode("utf-8") + (1).to_bytes(4, "big")).hex(),
}

# ---- Row-AEAD composition KAT (pins K_data + AAD + fixed nonce -> ct) ----
# Uses the SAME K_data derived above; a fixed 12-byte nonce and a payload whose
# JSON serialization is byte-identical to JS JSON.stringify of the mirrored
# object literal (compact separators, same key order).
ROW_ID = "cal:20261030"
ROW_VER = 7
ROW_NONCE = bytes.fromhex("0a0b0c0d0e0f101112131415")
ROW_PAYLOAD = {
    "events": [
        {
            "id": "w:11111111-2222-3333-4444-555555555555",
            "date": "2026-11-01",
            "hh": 8,
            "mm": 30,
            "title": "KAT",
            "priority": 1,
        }
    ]
}
row_pt = json.dumps(ROW_PAYLOAD, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
row_aad = ROW_ID.encode("utf-8") + ROW_VER.to_bytes(4, "big")
_c = AES.new(bytes.fromhex(kat["k_data_hex"]), AES.MODE_GCM, nonce=ROW_NONCE, mac_len=16)
_c.update(row_aad)
row_ct = _c.encrypt(row_pt)
row_tag = _c.digest()
kat["row_id"] = ROW_ID
kat["row_ver"] = ROW_VER
kat["row_nonce_hex"] = ROW_NONCE.hex()
kat["row_aad_hex"] = row_aad.hex()
kat["row_pt"] = row_pt.decode("utf-8")
kat["row_ct_hex"] = (row_ct + row_tag).hex()

print(json.dumps(kat, indent=2))
