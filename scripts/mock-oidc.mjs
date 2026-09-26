// Tiny OIDC provider for local testing: auto-approves logins as a fake user. NOT for production.
//   node scripts/mock-oidc.mjs      env: PORT=9200 CLIENT_ID=obsidianweb CLIENT_SECRET=s3cret
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const PORT = Number(process.env.PORT ?? 9200);
const ISS = `http://localhost:${PORT}`;
const CLIENT_ID = process.env.CLIENT_ID ?? "obsidianweb";
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "s3cret";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const codes = new Map();

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, ISS);
    const send = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    if (u.pathname === "/.well-known/openid-configuration")
      return send({
        issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
    if (u.pathname === "/jwks") return send({ keys: [jwk] });
    if (u.pathname === "/authorize") {
      const code = randomBytes(8).toString("hex");
      codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirect: u.searchParams.get("redirect_uri") });
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state"));
      back.searchParams.set("iss", ISS);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const c = codes.get(p.get("code"));
      const verifierOk = c && createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === c.challenge;
      if (!verifierOk) return send({ error: "invalid_grant" }, 400);
      codes.delete(p.get("code"));
      const id_token = await new SignJWT({ name: "Test User", email: "test@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISS).setAudience(CLIENT_ID).setSubject("user-1")
        .setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return send({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token });
    }
    send({ error: "not found" }, 404);
  })
  .listen(PORT, () => console.log(`mock OIDC on ${ISS} (client ${CLIENT_ID} / ${CLIENT_SECRET})`));
