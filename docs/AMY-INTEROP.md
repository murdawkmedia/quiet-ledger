# Amy interoperability

Quiet Ledger uses Marmot for two-person private messages. Amy is the Amethyst
CLI and can act as an independent Marmot peer. A participant uses a separate
messaging identity and shares its public key. No invoice, account, wallet or
email permission is granted by joining a room.

On unlock, a new dedicated Quiet Ledger messaging identity advertises its
approved write relays through NIP-65 (kind 10002). This lets current Marmot
clients locate its KeyPackage. Inbox delivery still uses kind 10050. Quiet
Ledger leaves an existing NIP-65 list it discovers for that identity intact.
Both clients need compatible Marmot versions and a shared approved route for
delivery. [Marmot transport specification](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md#key-package-publication)

## Local verification

Use Node 26, JDK 21, OpenSSL, and Linux user/network namespaces. Get Amy from
the [Amethyst release](https://github.com/vitorpamplona/amethyst/releases/tag/v1.21.0)
or build it using the [CLI guide](https://github.com/vitorpamplona/amethyst/blob/v1.21.0/cli/README.md).
Install Quiet Ledger's locked npm dependencies before entering the namespace.
Point to the Amy launcher and JDK with absolute paths.

```sh
QUIET_LEDGER_AMY_BIN=/absolute/path/to/bin/amy \
JAVA_HOME=/absolute/path/to/jdk-21 \
unshare --user --map-root-user --net sh -c 'ip link set lo up && ip addr add 192.0.2.55/32 dev lo && exec npm run test:interop:amy'
```

The runner uses fresh fictional identities, an in-memory loopback WSS relay,
a temporary certificate, and a separate Amy state directory. It requires a
namespace with only loopback and removes that state afterward. It checks that
both peers publish signed KeyPackages, each can invite the other, each
decrypts and replies to Unicode text in the two rooms, and the relay receives
ciphertext. The check covers Quiet Ledger's production messaging engine and
relay adapter. Browser interaction, live relay policy, and installed mobile
clients are separate acceptance checks.
