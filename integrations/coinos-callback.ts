/**
 * Strict provider-specific compatibility exception for Coinos LNURL receivers.
 *
 * Coinos advertises Lightning Address metadata from coinos.io, v3.coinos.io or
 * names.coinos.io with an HTTPS callback on names.coinos.io that carries
 * exactly one `domain=coinos.io` query parameter. Generic LNURL receiving
 * stays same-origin with a fixed query allowlist; this module recognizes only
 * that exact callback shape, bound to the same canonical recipient path, and
 * is shared by connection verification and invoice creation so the two
 * cannot diverge. Every other origin, host, recipient, port, credential,
 * fragment or parameter still follows the generic rules.
 */
const DISCOVERY_HOSTS=new Set(['coinos.io','v3.coinos.io','names.coinos.io']);
const CALLBACK_HOST='names.coinos.io';
const DOMAIN='coinos.io';
const RECIPIENT_PATH=/^\/(?:\.well-known\/)?lnurlp\/([a-z0-9][a-z0-9_.-]{0,63})$/;
const CALLBACK_PATH=/^\/(?:\.well-known\/)?lnurlp\/([a-z0-9][a-z0-9_.-]{0,63})\/cb$/;
const httpsOrigin=(url:URL)=>url.protocol==='https:'&&url.port===''&&!url.username&&!url.password&&!url.hash;
const recipient=(path:string,pattern:RegExp):string|null=>pattern.exec(path)?.[1]??null;

/** Public Coinos LNURL-pay discovery metadata endpoint shape. */
export function isCoinosDiscoveryEndpoint(url:URL):boolean {
  return httpsOrigin(url)&&DISCOVERY_HOSTS.has(url.hostname)&&recipient(url.pathname,RECIPIENT_PATH)!==null;
}

/** Exact Coinos callback shape: single `domain=coinos.io` parameter and, when a discovery path is supplied, the same canonical recipient. */
export function isCoinosCallbackUrl(url:URL,discoveryPath?:string):boolean {
  if(!httpsOrigin(url)||url.hostname!==CALLBACK_HOST)return false;
  const who=recipient(url.pathname,CALLBACK_PATH);
  if(!who)return false;
  if(discoveryPath!==undefined&&recipient(discoveryPath,RECIPIENT_PATH)!==who)return false;
  const entries=[...url.searchParams.entries()];
  return entries.length===1&&entries[0][0]==='domain'&&entries[0][1]===DOMAIN;
}

/** Shared entry point: discovery must itself be Coinos and the callback bound to its recipient. */
export function coinosCallbackAllowed(discovery:URL,callback:URL):boolean {
  return isCoinosDiscoveryEndpoint(discovery)&&isCoinosCallbackUrl(callback,discovery.pathname);
}

/**
 * Transport-stage recognition of a Coinos callback after the adapter appended
 * its validated `amount`; no other parameter, host, port or path shape is ever
 * admitted by this exception.
 */
export function isCoinosCallbackRequest(url:URL):boolean {
  if(!httpsOrigin(url)||url.hostname!==CALLBACK_HOST||!recipient(url.pathname,CALLBACK_PATH))return false;
  const entries=[...url.searchParams.entries()];
  const domains=entries.filter(([name])=>name==='domain');
  return domains.length===1&&domains[0][1]===DOMAIN&&entries.every(([name,value])=>(name==='domain'||name==='amount')&&value.length>0);
}
