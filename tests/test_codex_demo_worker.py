"""Bounded native app-server protocol tests; no real login or model is used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from test_demo_agent_worker import answer, payload

MODULE = Path(__file__).resolve().parents[1] / 'agents/demo/codex_worker.py'

# This separate process speaks enough of the public native protocol to expose
# routing, isolation, fail-closed admission and process cleanup to the tests.
FAKE_SERVER = r'''
import json, os, signal, stat, subprocess, sys, time, tomllib
from pathlib import Path
mode = __MODE__
report = Path(__REPORT__)
seen = []
config = {'mcp_servers': {'active-default': {'enabled': True}, 'quoted.name': {'enabled': True}}}
for index, arg in enumerate(sys.argv):
    if arg == '-c':
        def merge(dst, src):
            for key, value in src.items():
                if isinstance(value, dict): merge(dst.setdefault(key, {}), value)
                else: dst[key] = value
        merge(config, tomllib.loads(sys.argv[index + 1]))
def save():
    report.write_text(json.dumps({'argv':sys.argv[1:], 'env':dict(os.environ), 'cwd':os.getcwd(),
                                  'mode':stat.S_IMODE(Path.cwd().stat().st_mode), 'seen':seen, 'pid':os.getpid()}))
def emit(row):
    print(json.dumps(row), flush=True)
def result(row, value): emit({'id':row['id'], 'result':value})
def event(method, params): emit({'method':method, 'params':params})
save()
for line in sys.stdin:
    row=json.loads(line);seen.append(row);save()
    method=row.get('method')
    if method == 'initialize':
        if mode == 'line_flood':
            sys.stdout.write('x' * 300000);sys.stdout.flush();time.sleep(10)
        if mode == 'partial_line':
            sys.stdout.write('{');sys.stdout.flush();time.sleep(10)
        if mode == 'stderr_noise':
            sys.stderr.write('private native diagnostic' * 10000);sys.stderr.flush()
        result(row,{})
    elif method == 'config/read':
        if mode == 'mcp_enabled': config['mcp_servers']['managed']={'enabled': True}
        if mode == 'shell_enabled': config['features']['shell_tool']=True
        if mode == 'image_enabled': config['features']['view_image']=True
        if mode == 'image_generation_enabled': config['features']['image_generation']=True
        if mode == 'api_auth': config['forced_login_method']='api'
        result(row,{'config':config})
    elif method == 'mcpServerStatus/list':
        result(row, {'data':[{'name':'active-default', 'tools':{'unsafe':{}} if mode=='mcp_tools' else {}}],
                     'nextCursor':'more' if mode=='mcp_page' else None})
    elif method == 'account/read':
        result(row, {'account':{'type':'apiKey' if mode=='api_account' else 'chatgpt'}})
    elif method == 'thread/start':
        if mode == 'tool_request':
            emit({'id':99,'method':'item/tool/call','params':{'arguments':'private tool input'}})
            continue
        result(row,{'thread':{'id':'thread-fixture'}, 'model':'other-model' if mode=='model_fallback' else 'gpt-6-luna',
                    'modelProvider':'openai', 'reasoningEffort':'max', 'approvalPolicy':'never',
                    'sandbox':{'type':'readOnly'}, 'instructionSources':[]})
    elif method == 'turn/start':
        if mode == 'timeout':
            child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
            report.with_suffix('.child').write_text(str(child.pid));time.sleep(30)
        if mode == 'event_flood':
            for _ in range(5000):event('thread/tokenUsage/updated', {})
        if mode == 'stdout_flood':
            for _ in range(200):event('thread/tokenUsage/updated', {'ignored':'x'*20000})
        if mode == 'unknown_event': event('item/futureTool/started', {})
        event('turn/started', {'threadId':'thread-fixture','turn':{'id':'turn-fixture','status':'inProgress'}})
        result(row, {'turn':{'id':'turn-fixture','status':'inProgress'}})
        item_type='commandExecution' if mode=='tool_item' else 'reasoning'
        event('item/started', {'threadId':'thread-fixture','turnId':'turn-fixture','item':{'id':'reason','type':item_type}})
        event('item/completed', {'threadId':'thread-fixture','turnId':'turn-fixture','item':{'id':'reason','type':item_type,
                                                                                       'text':'private reasoning'}})
        text = '{"intent":"conversation","reply":"I help keep the workshop scope clear. What would you like reviewed?"}'
        if mode=='bad_output':text='{"intent":"conversation","reply":"The payment arrived."}'
        if mode=='duplicate_json':text='{"intent":"conversation","intent":"check-total","reply":"Okay."}'
        if mode=='extra_output':text='{"intent":"conversation","reply":"Okay.","secret":"never"}'
        # Deltas are deliberately not the terminal message and must be ignored.
        event('item/agentMessage/delta', {'threadId':'thread-fixture','turnId':'turn-fixture','delta':'private partial output'})
        terminal={'threadId':'wrong-room' if mode=='wrong_room' else 'thread-fixture','turnId':'turn-fixture',
                  'item':{'id':'final','type':'agentMessage','phase':'final_answer','text':text}}
        if mode!='missing_output': event('item/completed',terminal)
        if mode=='duplicate_final':event('item/completed',terminal)
        event('turn/completed', {'threadId':'thread-fixture','turn':{'id':'turn-fixture',
                               'status':'failed' if mode=='failed_turn' else 'completed'}})
'''


class CodexWorkerContract(unittest.TestCase):
    def load(self):
        self.assertTrue(MODULE.is_file(), 'separate Codex subscription worker is missing')
        spec=importlib.util.spec_from_file_location('quiet_ledger_codex_worker', MODULE)
        module=importlib.util.module_from_spec(spec)
        sys.path.insert(0,str(MODULE.parent))
        try: spec.loader.exec_module(module)
        finally: sys.path.pop(0)
        return module

    def fixture(self, root, mode='success', deadline=2):
        module=self.load()
        state=root/'state';state.mkdir(mode=0o700)
        native_home=root/'native-home';native_home.mkdir(mode=0o700)
        config=native_home/'.codex';config.mkdir(mode=0o700)
        (config/'config.toml').write_text('[mcp_servers.active-default]\ncommand="not-started"\n[mcp_servers."quoted.name"]\ncommand="not-started"\n')
        # A dummy file checks that the wrapper never reads/copies native auth.
        (config/'auth.json').write_text('fictional-auth-sentinel')
        report=root/'report.json';executable=root/'fake-codex'
        executable.write_text('#!'+sys.executable+'\n'+FAKE_SERVER.replace('__MODE__',repr(mode)).replace('__REPORT__',repr(str(report))))
        executable.chmod(0o700)
        return module, state, native_home, report, executable

    def invoke(self, mode='success', deadline=2):
        with tempfile.TemporaryDirectory(prefix='ql-codex-test-') as folder:
            root=Path(folder);module,state,native_home,report,executable=self.fixture(root,mode,deadline)
            before=(native_home/'.codex/auth.json').stat()
            env={'HOME':str(native_home),'OPENAI_API_KEY':'fictional-api-sentinel',
                 'CODEX_HOME':'/do-not-use-this-profile','MCP_SECRET':'fictional-mcp-sentinel',
                 'QUIET_LEDGER_WORKER_TOKEN_FILE':'/not-a-model-credential'}
            with patch.dict(os.environ,env):
                inference=module.CodexInference(state_dir=str(state),codex=str(executable),deadline=deadline)
                try: value=inference(payload('accountant'))
                except module.ServiceError as error: value=error
            after=(native_home/'.codex/auth.json').stat()
            self.assertEqual((before.st_mtime_ns,before.st_size),(after.st_mtime_ns,after.st_size))
            self.assertEqual(list(state.iterdir()),[])
            return module,value,json.loads(report.read_text())

    def test_exact_subscription_model_and_same_fictional_context_without_tools(self):
        module,value,report=self.invoke()
        self.assertEqual(value,answer(reply='I help keep the workshop scope clear. What would you like reviewed?'))
        self.assertEqual(report['mode'],0o700)
        self.assertFalse(Path(report['cwd']).exists())
        self.assertEqual(report['argv'][:3],['app-server','--listen','stdio://'])
        seen={row['method']:row.get('params') for row in report['seen'] if 'method' in row}
        thread=seen['thread/start'];turn=seen['turn/start']
        self.assertEqual(thread['model'],'gpt-6-luna');self.assertIs(thread['allowProviderModelFallback'],False)
        self.assertEqual(thread['approvalPolicy'],'never');self.assertEqual(thread['sandbox'],'read-only')
        self.assertIs(thread['ephemeral'],True)
        self.assertEqual(thread['dynamicTools'],[]);self.assertEqual(thread['selectedCapabilityRoots'],[])
        self.assertIn('Jordan',thread['baseInstructions']);self.assertIn('Marmot Field Lab',thread['baseInstructions'])
        self.assertIn('fictional',thread['developerInstructions'].lower())
        self.assertEqual(turn['model'],'gpt-6-luna');self.assertEqual(turn['effort'],'max')
        self.assertEqual(turn['input'],[{'type':'text','text':module.demo_prompt(payload('accountant'))[1]}])
        schema=turn['outputSchema'];self.assertIs(schema['additionalProperties'],False)
        self.assertEqual(set(schema['properties']['intent']['enum']),module.INTENTS)
        self.assertEqual(set(report['env'])-{'PATH','HOME','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','LC_CTYPE'},set())
        serialized=json.dumps(report)
        for forbidden in ['fictional-api-sentinel','fictional-mcp-sentinel','fictional-auth-sentinel','/do-not-use-this-profile']:
            self.assertNotIn(forbidden,serialized)

    def test_effective_mcp_config_and_tools_are_checked_before_model_turn(self):
        for mode in ['mcp_enabled','mcp_tools','mcp_page','shell_enabled','image_enabled',
                     'image_generation_enabled','api_auth','api_account']:
            with self.subTest(mode=mode):
                module,value,report=self.invoke(mode)
                self.assertIsInstance(value,module.ServiceError)
                self.assertEqual(value.status,502)
                self.assertFalse(any(row.get('method')=='thread/start' for row in report['seen']))

    def test_fallback_model_is_rejected_before_a_turn(self):
        module,value,report=self.invoke('model_fallback')
        self.assertIsInstance(value,module.ServiceError)
        self.assertFalse(any(row.get('method')=='turn/start' for row in report['seen']))

    def test_server_tool_or_approval_request_is_rejected_without_execution(self):
        module,value,report=self.invoke('tool_request')
        self.assertIsInstance(value,module.ServiceError)
        self.assertEqual(value.status,502)
        self.assertNotIn('private tool input',str(value))
        self.assertFalse(any(row.get('method')=='turn/start' for row in report['seen']))

    def test_only_valid_terminal_message_from_this_turn_is_returned(self):
        for mode in ['tool_item','unknown_event','bad_output','duplicate_json','extra_output',
                     'wrong_room','missing_output','duplicate_final','failed_turn']:
            with self.subTest(mode=mode):
                module,value,_=self.invoke(mode)
                self.assertIsInstance(value,module.ServiceError)
                self.assertEqual(value.status,502)
                self.assertNotIn('private',str(value))

    def test_no_stderr_or_partial_output_escapes(self):
        module,value,_=self.invoke('stderr_noise')
        self.assertEqual(value['intent'],'conversation')
        self.assertNotIn('private',json.dumps(value))

    def test_stdout_line_event_and_hard_deadline_are_bounded(self):
        for mode,status in [('line_flood',502),('event_flood',502),('stdout_flood',502),('partial_line',504)]:
            with self.subTest(mode=mode):
                start=time.monotonic();module,value,_=self.invoke(mode,deadline=0.5)
                self.assertIsInstance(value,module.ServiceError);self.assertEqual(value.status,status)
                self.assertLess(time.monotonic()-start,2)

    def test_deadline_kills_the_owned_process_group_and_removes_request_directory(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-timeout-') as folder:
            root=Path(folder);module,state,native_home,report,executable=self.fixture(root,'timeout')
            with patch.dict(os.environ,{'HOME':str(native_home)}):
                inference=module.CodexInference(state_dir=str(state),codex=str(executable),deadline=0.4)
                with self.assertRaises(module.ServiceError) as caught:inference(payload('accountant'))
            self.assertEqual(caught.exception.status,504)
            self.assertEqual(list(state.iterdir()),[])
            for pid in [json.loads(report.read_text())['pid'],int(report.with_suffix('.child').read_text())]:
                status=Path('/proc')/str(pid)/'stat'
                self.assertTrue(not status.exists() or status.read_text().split()[2]=='Z', 'owned child remains running')

    def test_invalid_or_other_role_request_never_starts_a_native_process(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-admission-') as folder:
            root=Path(folder);module,state,native_home,report,executable=self.fixture(root)
            with patch.dict(os.environ,{'HOME':str(native_home)}):
                inference=module.CodexInference(state_dir=str(state),codex=str(executable))
                for request in [payload('client'),dict(payload('accountant'),extra='private')]:
                    with self.assertRaises(module.ServiceError) as caught:inference(request)
                    self.assertEqual(caught.exception.status,400)
            self.assertFalse(report.exists());self.assertEqual(list(state.iterdir()),[])

    def test_health_identifies_fixed_model_and_effort_without_inference(self):
        module=self.load()
        self.assertTrue(hasattr(module,'CodexService'),'Codex health contract is missing')
        service=module.CodexService(token='t'*43,infer=lambda request:self.fail('health called the model'))
        self.assertEqual(service.health(),{'runtime':'codex','model':'gpt-6-luna','reasoningEffort':'max',
                                         'ready':True,'mode':'fictional-conversation-only'})

    def test_binary_override_requires_an_absolute_existing_executable(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-binary-') as folder:
            root=Path(folder);module,state,_,_,_=self.fixture(root)
            for executable in ['relative-codex','/not-installed/quiet-ledger-codex',42]:
                with self.assertRaises(ValueError):
                    module.CodexInference(state_dir=str(state),codex=executable)

    def test_isolated_python_invocation_loads_only_its_explicit_sibling(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-isolated-') as folder:
            Path(folder,'worker.py').write_text('raise RuntimeError("untrusted working-directory module loaded")\n')
            result=subprocess.run([sys.executable,'-I','-B',str(MODULE),'--help'],cwd=folder,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('127.0.0.1',result.stdout)


if __name__ == '__main__':unittest.main()
