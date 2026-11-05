#!/usr/bin/env python3
"""Loopback-only fictional Jordan inference using an existing Codex ChatGPT login.

The native app-server owns authentication. This wrapper never reads, copies or
supplies auth tokens, API keys, personal profiles or conversation databases.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import select
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

# Isolated Python (-I) omits the script directory. Only this resolved sibling
# directory is admitted; neither the working directory nor PYTHONPATH is used.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker import (INTENTS, InferenceService, ServiceError, _private_path,
                    _strict_json, demo_prompt, make_server, read_private_secret,
                    validate_reply, validate_request)

MODEL = 'gpt-6-luna'
EFFORT = 'max'
MAX_LINE = 262144
MAX_STDOUT = 2097152
MAX_EVENTS = 4096
# These are native feature IDs verified with the installed Codex feature list.
# Disable capability sources only; inference/authentication features stay intact.
DISABLED_FEATURES = (
    'shell_tool', 'unified_exec', 'shell_snapshot', 'shell_snapshot_v2',
    'apps', 'multi_agent', 'multi_agent_v2', 'multi_agent_v2_dynamic_tools', 'hooks', 'skill_search',
    'view_image', 'image_generation', 'sleep_tool', 'tool_suggest', 'request_permissions_tool',
    'code_mode', 'code_mode_host', 'code_mode_only', 'code_mode_tool_search',
    'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
    'in_app_browser', 'in_app_local_automation', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch',
    'goals', 'artifact', 'memories', 'skill_mcp_dependency_install', 'tool_call_mcp_elicitation',
    'auth_elicitation', 'workspace_dependencies',
)
ENABLED_FEATURES = ('skip_host_skill_discovery', 'omit_skill_descriptions')
OUTPUT_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {'intent': {'type': 'string', 'enum': sorted(INTENTS)},
                   'reply': {'type': 'string', 'minLength': 1, 'maxLength': 1000}},
    'required': ['intent', 'reply'],
}


def _configuration():
    # An empty map merges with native config rather than removing its servers.
    # Read only config server *names* to disable each definition explicitly.
    # Authentication remains entirely inside native Codex.
    path = Path.home() / '.codex' / 'config.toml'
    names = []
    if path.exists():
        with path.open('rb') as stream:
            raw = stream.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('native config exceeds boundary')
        servers = tomllib.loads(raw.decode('utf-8')).get('mcp_servers', {})
        if not isinstance(servers, dict) or len(servers) > 128:
            raise ValueError('invalid native server configuration')
        names = list(servers)
    config = {'model': json.dumps(MODEL), 'model_provider': '"openai"',
              'forced_login_method': '"chatgpt"', 'model_reasoning_effort': json.dumps(EFFORT),
              'mcp_servers': '{' + ','.join(json.dumps(name) + '={enabled=false}' for name in names) + '}',
              'web_search': '"disabled"', 'project_doc_max_bytes': '0'}
    config.update({'features.' + name: 'false' for name in DISABLED_FEATURES})
    config.update({'features.' + name: 'true' for name in ENABLED_FEATURES})
    # The inline map explicitly overrides every definition, including names with
    # dots. Native -c splits dotted paths without honoring quoted key segments.
    return config, names


def _check_configuration(result, names):
    config = result.get('config')
    if not isinstance(config, dict):
        raise ValueError('missing effective config')
    for key, wanted in [('model', MODEL), ('model_provider', 'openai'),
                        ('model_reasoning_effort', EFFORT), ('forced_login_method', 'chatgpt'),
                        ('web_search', 'disabled'), ('project_doc_max_bytes', 0)]:
        if config.get(key) != wanted:
            raise ValueError('native config did not enforce inference boundary')
    features = config.get('features', {})
    if (not isinstance(features, dict)
            or any(features.get(name) is not False for name in DISABLED_FEATURES)
            or any(features.get(name) is not True for name in ENABLED_FEATURES)):
        raise ValueError('native tools are enabled')
    servers = config.get('mcp_servers', {})
    if (not isinstance(servers, dict) or not set(names).issubset(servers)
            or any(not isinstance(value, dict) or value.get('enabled') is not False
                   for value in servers.values())):
        raise ValueError('native MCP definition is enabled')


class _Protocol:
    """One bounded stdio session. Event payloads are never logged or retained."""
    def __init__(self, process, deadline):
        self.process = process
        self.deadline = deadline
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        os.set_blocking(process.stdout.fileno(), False)
        os.set_blocking(process.stdin.fileno(), False)
        self.buffer = bytearray()
        self.byte_count = 0
        self.event_count = 0
        self.sequence = 0
        self.thread_id = None
        self.turn_id = None
        self.turn_requested = False
        self.completed = False
        self.final = None

    def remaining(self):
        seconds = self.deadline - time.monotonic()
        if seconds <= 0:
            raise ServiceError(504, 'Codex inference timed out')
        return min(seconds, 0.25)

    def send(self, row):
        data = json.dumps(row, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        if len(data) > 65536:
            raise ValueError('native request exceeds boundary')
        while data:
            remaining = self.remaining()
            if not select.select([], [self.process.stdin], [], remaining)[1]:
                continue
            try:
                size = os.write(self.process.stdin.fileno(), data)
            except BlockingIOError:
                continue
            if size <= 0:
                raise ValueError('native stdin closed')
            data = data[size:]

    def read(self):
        while True:
            self.remaining()
            end = self.buffer.find(b'\n')
            if end >= 0:
                if end > MAX_LINE:
                    raise ValueError('native line exceeds boundary')
                raw = bytes(self.buffer[:end])
                del self.buffer[:end + 1]
                self.event_count += 1
                if self.event_count > MAX_EVENTS:
                    raise ValueError('too many native events')
                row = _strict_json(raw.decode('utf-8'))
                if not isinstance(row, dict):
                    raise ValueError('invalid native event')
                return row
            if len(self.buffer) > MAX_LINE:
                raise ValueError('native line exceeds boundary')
            if not self.selector.select(self.remaining()):
                continue
            chunk = os.read(self.process.stdout.fileno(), 8192)
            if not chunk:
                raise ValueError('native process stopped')
            self.byte_count += len(chunk)
            if self.byte_count > MAX_STDOUT:
                raise ValueError('native stdout exceeds boundary')
            self.buffer.extend(chunk)

    def notification(self, row):
        method = row.get('method')
        if not isinstance(method, str):
            raise ValueError('unexpected native response')
        if 'id' in row:
            # No permission prompt, dynamic tool, token refresh or other server
            # request is accepted. The native child is terminated immediately.
            self.send({'id': row['id'], 'error': {'code': -32601, 'message': 'Tools and approvals are disabled'}})
            raise ValueError('native server request is forbidden')
        params = row.get('params', {})
        if not isinstance(params, dict):
            raise ValueError('invalid native notification')
        if method == 'turn/started':
            turn_id = params.get('turn', {}).get('id')
            if (not self.turn_requested or params.get('threadId') != self.thread_id
                    or not isinstance(turn_id, str) or not turn_id
                    or self.turn_id is not None and self.turn_id != turn_id):
                raise ValueError('unexpected native turn')
            self.turn_id = turn_id
        elif method in ('item/started', 'item/completed'):
            item = params.get('item', {})
            if (not self.turn_id or params.get('threadId') != self.thread_id
                    or params.get('turnId') != self.turn_id or not isinstance(item, dict)
                    or item.get('type') not in ('userMessage', 'reasoning', 'agentMessage')):
                raise ValueError('native tool or unrelated output is forbidden')
            if method == 'item/completed' and item['type'] == 'agentMessage':
                phase = item.get('phase')
                if phase in (None, 'final_answer'):
                    if self.final is not None:
                        raise ValueError('multiple native answers')
                    text = item.get('text')
                    if not isinstance(text, str) or len(text.encode('utf-8')) > 4096:
                        raise ValueError('native answer exceeds boundary')
                    self.final = text
                elif phase not in ('commentary', 'partial_answer'):
                    raise ValueError('unknown native answer phase')
        elif method == 'turn/completed':
            turn = params.get('turn', {})
            if (not self.turn_id or params.get('threadId') != self.thread_id
                    or turn.get('id') != self.turn_id or turn.get('status') != 'completed'
                    or self.completed):
                raise ValueError('native turn failed')
            self.completed = True
        elif method in ('item/agentMessage/delta', 'item/reasoning/textDelta',
                        'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
                        'account/rateLimits/updated', 'account/updated', 'configWarning',
                        'remoteControl/status/changed', 'thread/started', 'thread/status/changed',
                        'thread/tokenUsage/updated', 'turn/moderationMetadata', 'warning'):
            pass  # Discard partial prose, reasoning and account/token metadata.
        else:
            raise ValueError('unknown native event')

    def request(self, method, params):
        self.sequence += 1
        identity = self.sequence
        self.send({'id': identity, 'method': method, 'params': params})
        while True:
            row = self.read()
            if 'method' in row:
                self.notification(row)
            elif row.get('id') == identity and 'error' not in row and isinstance(row.get('result'), dict):
                return row['result']
            else:
                raise ValueError('native request failed')

    def reply(self):
        while not self.completed:
            self.notification(self.read())
        if self.final is None:
            raise ValueError('native answer is missing')
        return validate_reply(_strict_json(self.final))

    def close(self):
        self.selector.close()


def _stop(process):
    # Always signal our own process group, even if its leader already exited.
    # A failed native request must not leave a descendant or stdout pipe behind.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    for stream in (process.stdin, process.stdout):
        stream.close()


class CodexInference:
    def __init__(self, *, state_dir, codex='codex', deadline=27):
        if not isinstance(deadline, (int, float)) or not 0 < deadline <= 30:
            raise ValueError('invalid Codex deadline')
        if (not isinstance(codex, str) or codex != 'codex' and
                (not Path(codex).is_absolute() or not Path(codex).is_file() or not os.access(codex, os.X_OK))):
            raise ValueError('Codex binary override must be an absolute executable')
        self.state_dir = _private_path(state_dir, directory=True)
        self.codex = codex
        self.deadline = deadline

    def __call__(self, value):
        request = validate_request(value)
        if request['role'] != 'accountant':
            raise ServiceError(400, 'unsupported Codex demo role')
        try:
            config, names = _configuration()
            command = [self.codex, 'app-server', '--listen', 'stdio://']
            for key, value in config.items():
                command.extend(['-c', key + '=' + value])
            allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR')
            env = {key: os.environ[key] for key in allowed if key in os.environ}
            with tempfile.TemporaryDirectory(prefix='accountant-', dir=self.state_dir) as cwd:
                deadline = time.monotonic() + self.deadline
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, cwd=cwd, env=env,
                                           start_new_session=True)
                protocol = None
                try:
                    protocol = _Protocol(process, deadline)
                    protocol.request('initialize', {'clientInfo': {'name': 'quiet_ledger_demo',
                                     'title': 'Quiet Ledger fictional demo', 'version': '0.1.0'},
                                     'capabilities': {'experimentalApi': True}})
                    protocol.send({'method': 'initialized', 'params': {}})
                    _check_configuration(protocol.request('config/read', {'includeLayers': False}), names)
                    # Ask native Codex for only its login type. Never inspect its
                    # auth files or log account identity, plan or token metadata.
                    account = protocol.request('account/read', {'refreshToken': False}).get('account')
                    if not isinstance(account, dict) or account.get('type') != 'chatgpt':
                        raise ValueError('native ChatGPT login is required')
                    mcp = protocol.request('mcpServerStatus/list', {})
                    if (not isinstance(mcp.get('data'), list) or mcp.get('nextCursor')
                            or any(not isinstance(server, dict) or server.get('tools') not in ({}, [])
                                   for server in mcp['data'])):
                        raise ValueError('native MCP tools are present')
                    system, human = demo_prompt(request)
                    thread = protocol.request('thread/start', {
                        'model': MODEL, 'modelProvider': 'openai', 'allowProviderModelFallback': False,
                        'cwd': cwd, 'ephemeral': True, 'approvalPolicy': 'never', 'sandbox': 'read-only',
                        'baseInstructions': system,
                        'developerInstructions': 'Fictional text-only roleplay. Follow the shared demo rules. '
                        'Do not use tools, read files, access integrations, or claim a completed action. '
                        'Return only the requested JSON object.',
                        'selectedCapabilityRoots': [], 'dynamicTools': [],
                    })
                    if (thread.get('model') != MODEL or thread.get('modelProvider') != 'openai'
                            or thread.get('reasoningEffort') != EFFORT
                            or thread.get('approvalPolicy') != 'never'
                            or thread.get('sandbox', {}).get('type') != 'readOnly'
                            or thread.get('instructionSources')):
                        raise ValueError('native thread changed inference boundary')
                    protocol.thread_id = thread.get('thread', {}).get('id')
                    if not isinstance(protocol.thread_id, str) or not protocol.thread_id:
                        raise ValueError('invalid native thread')
                    protocol.turn_requested = True
                    turn = protocol.request('turn/start', {'threadId': protocol.thread_id,
                                            'model': MODEL, 'effort': EFFORT,
                                            'input': [{'type': 'text', 'text': human}],
                                            'outputSchema': OUTPUT_SCHEMA})
                    turn_id = turn.get('turn', {}).get('id')
                    if (not isinstance(turn_id, str) or not turn_id
                            or protocol.turn_id is not None and protocol.turn_id != turn_id):
                        raise ValueError('unexpected native turn response')
                    protocol.turn_id = turn_id
                    return protocol.reply()
                finally:
                    if protocol is not None:
                        protocol.close()
                    _stop(process)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(502, 'Codex inference unavailable') from None


class CodexService(InferenceService):
    def __init__(self, *, token, infer):
        super().__init__(token=token, model=MODEL, infer=infer, runtime='codex')

    def health(self):
        return {**super().health(), 'reasoningEffort': EFFORT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['127.0.0.1'], default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4441)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit('unsupported listen port')
    try:
        token = read_private_secret(os.environ['QUIET_LEDGER_WORKER_TOKEN_FILE'])
        inference = CodexInference(state_dir=os.environ['QUIET_LEDGER_CODEX_STATE'],
                                   codex=os.environ.get('QUIET_LEDGER_CODEX_BINARY', 'codex'))
        service = CodexService(token=token, infer=inference)
    except (ValueError, KeyError, OSError):
        raise SystemExit('private Codex demo runtime configuration is unavailable') from None
    server = make_server(args.host, args.port, service)
    print('Quiet Ledger fictional Codex conversation worker ready', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
