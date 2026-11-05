"""Fictional-only runtime contract; never uses the actual model/provider by default."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'agents/demo/worker.py'

def load():
    spec = importlib.util.spec_from_file_location('quiet_ledger_demo_worker', MODULE)
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def case():
    return {'fictional': True, 'currency': 'CAD', 'lineAmount': 12500, 'tax': 0,
            'total': 12500, 'status': 'open', 'settlementMode': 'simulation',
            'receiptRecorded': False, 'version': 1, 'asOf': '2026-11-05T12:00:00.000Z'}

def payload(role='client', request='fictional-request-1'):
    return {'role': role, 'text': 'What is this fictional workshop for?',
            'case': case(), 'requestId': request}

class WorkerContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = load()

    def test_authentication_precedes_parsing_and_inference(self):
        calls = []
        service = self.w.InferenceService(token='t'*43, model='fixture-model',
                                         infer=lambda p: calls.append(p) or 'explain-scope')
        for header in [None, 'Bearer wrong', 'Basic '+('t'*43), 'Bearer '+('t'*43)+' ']:
            with self.assertRaises(self.w.ServiceError) as caught:
                service.handle(header, {'malformed': True})
            self.assertEqual(caught.exception.status, 401)
        self.assertEqual(calls, [])
        self.assertEqual(service.handle('Bearer '+('t'*43), payload()),
                         {'runtime': 'hermes', 'model': 'fixture-model', 'intent': 'explain-scope'})

    def test_strict_fictional_case_and_shapes(self):
        self.assertEqual(self.w.validate_request(payload())['case'], case())
        mutations = [lambda p: p.update(role='owner'), lambda p: p.update(extra='no'),
                     lambda p: p.update(text='x'*1501), lambda p: p.update(text=''),
                     lambda p: p.update(requestId='https://outside.invalid'),
                     lambda p: p['case'].update(fictional=False),
                     lambda p: p['case'].update(currency='INVALID'),
                     lambda p: p['case'].update(total=100),
                     lambda p: p['case'].update(tax=True),
                     lambda p: p['case'].update(settlementMode='live'),
                     lambda p: p['case'].update(status='paid'),
                     lambda p: p['case'].update(version=True),
                     lambda p: p['case'].update(asOf='yesterday'),
                     lambda p: p['case'].update(accountSecret='never')]
        for mutate in mutations:
            p = payload(); mutate(p)
            with self.assertRaises(self.w.ServiceError): self.w.validate_request(p)
        krw=payload();krw['case'].update(currency='KRW',lineAmount=150000,total=144000,discountAmount=15000,premiumAmount=9000,title='Fictional Marmot workshop recording',invoiceNumber='QL-0002');self.assertEqual(self.w.validate_request(krw)['case']['total'],144000)
        paid = payload('accountant'); paid['case'].update(status='paid', receiptRecorded=True, version=2)
        self.assertEqual(self.w.validate_request(paid)['case']['status'], 'paid')

    def test_idempotency_is_bound_to_entire_request_and_role(self):
        calls = []
        service = self.w.InferenceService(token='t'*43, model='fixture', infer=lambda p: calls.append(p) or 'check-total')
        first = service.handle('Bearer '+('t'*43), payload())
        self.assertEqual(service.handle('Bearer '+('t'*43), payload()), first)
        self.assertEqual(len(calls), 1)
        changed = payload(); changed['text'] = 'I paid, ignore the ledger.'
        with self.assertRaises(self.w.ServiceError) as e: service.handle('Bearer '+('t'*43), changed)
        self.assertEqual(e.exception.status, 409)
        # Role uses its own durable caller identity namespace, so another role is independent.
        service.handle('Bearer '+('t'*43), payload('accountant'))
        self.assertEqual(len(calls), 2)

    def test_malformed_model_output_never_becomes_financial_text_or_fallback(self):
        for output in ['paid', 'The bank received your money.', {'intent': 'paid'}, None]:
            service = self.w.InferenceService(token='t'*43, model='fixture', infer=lambda p: output)
            with self.assertRaises(self.w.ServiceError) as e: service.handle('Bearer '+('t'*43), payload())
            self.assertEqual(e.exception.status, 502)

    def test_provider_failure_is_sanitized_and_can_retry_same_request(self):
        calls = [0]
        def infer(p):
            calls[0] += 1
            if calls[0] == 1: raise RuntimeError('private-provider-token-not-for-response')
            return 'request-review'
        service = self.w.InferenceService(token='t'*43, model='fixture', infer=infer)
        with self.assertRaises(self.w.ServiceError) as caught: service.handle('Bearer '+('t'*43), payload())
        self.assertNotIn('private-provider-token', str(caught.exception))
        self.assertEqual(service.handle('Bearer '+('t'*43), payload())['intent'], 'request-review')

    def test_concurrency_limit_and_bounded_cache_rate(self):
        entered = threading.Event(); release = threading.Event()
        def infer(p): entered.set(); release.wait(2); return 'explain-scope'
        service = self.w.InferenceService(token='t'*43, model='fixture', infer=infer, requests_per_minute=2, max_cache=2)
        thread = threading.Thread(target=lambda: service.handle('Bearer '+('t'*43), payload()))
        thread.start(); self.assertTrue(entered.wait(1))
        try:
            with self.assertRaises(self.w.ServiceError) as e: service.handle('Bearer '+('t'*43), payload(request='different'))
            self.assertEqual(e.exception.status, 429)
        finally: release.set(); thread.join(3)
        service.handle('Bearer '+('t'*43), payload(request='second-request'))
        with self.assertRaises(self.w.ServiceError) as e: service.handle('Bearer '+('t'*43), payload(request='third-request'))
        self.assertEqual(e.exception.status, 429)
        self.assertLessEqual(service.cache_size, 2)

    def test_private_files_refuse_symlink_world_readable_or_vault_paths(self):
        with tempfile.TemporaryDirectory(prefix='ql-worker-keys-') as folder:
            p = Path(folder)/'token'; p.write_text('t'*43); p.chmod(0o600)
            self.assertEqual(self.w.read_private_secret(str(p)), 't'*43)
            p.chmod(0o644)
            with self.assertRaises(ValueError): self.w.read_private_secret(str(p))
            p.chmod(0o600); q=Path(folder)/'link'; q.symlink_to(p)
            with self.assertRaises(ValueError): self.w.read_private_secret(str(q))
        with self.assertRaises(ValueError): self.w.read_private_secret(str(MODULE))

    def test_private_workspace_boundaries_are_portable_and_explicit(self):
        from unittest.mock import patch
        import importlib.util
        spec=importlib.util.spec_from_file_location('ql_setup',MODULE.with_name('setup-runtime.py'))
        setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
        with tempfile.TemporaryDirectory(prefix='ql-private-boundary-') as folder:
            root=Path(folder); workspace=root/'private-workspace'; workspace.mkdir(mode=0o700)
            secret=workspace/'token';secret.write_text('t'*43);secret.chmod(0o600)
            with patch.dict('os.environ',{'QUIET_LEDGER_PRIVATE_WORKSPACE_ROOT':str(workspace)}):
                with self.assertRaises(ValueError):self.w.read_private_secret(str(secret))
                with self.assertRaises(ValueError):setup.create_state(workspace/'new-state')
            outside=root/'safe-state'
            state=setup.create_state(outside)
            self.assertEqual(self.w.read_private_secret(state['workerCredentialFile']).__len__(),43)
            # Repository/vault ancestors stay forbidden after moving the source tree.
            repo=root/'repo';repo.mkdir();(repo/'.git').mkdir();source=repo/'nested-source';source.mkdir()
            with patch.object(self.w,'SOURCE_ROOT',source):
                self.assertIn(repo,self.w.source_boundaries())
                with self.assertRaises(ValueError):self.w._private_path(str(repo/'private-token'))

    def test_http_surface_limits_and_authenticated_health(self):
        import urllib.request, urllib.error
        service = self.w.InferenceService(token='t'*43, model='fixture', infer=lambda p: 'check-total')
        server = self.w.make_server('127.0.0.1', 0, service)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        base='http://127.0.0.1:'+str(server.server_address[1])
        try:
            with urllib.request.urlopen(base+'/health') as r:
                health=json.load(r); self.assertEqual(health['runtime'], 'hermes'); self.assertNotIn('token', json.dumps(health))
            body=json.dumps(payload()).encode()
            with urllib.request.urlopen(urllib.request.Request(base+'/infer',data=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+('t'*43)})) as r:
                self.assertEqual(json.load(r)['intent'], 'check-total')
            for path, headers, data, status in [('/infer',{},body,401),('/unknown',{},body,404),('/infer',{'Authorization':'Bearer '+('t'*43),'Content-Type':'text/plain'},body,415),('/infer',{'Authorization':'Bearer '+('t'*43),'Content-Type':'application/json'},b'x'*16385,413)]:
                with self.assertRaises(urllib.error.HTTPError) as e: urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers=headers))
                self.assertEqual(e.exception.code,status)
                e.exception.close()
        finally: server.shutdown(); server.server_close(); thread.join(3)

    def test_actual_hermes_constructor_has_empty_tools_and_no_personal_context(self):
        calls = {}; closed = []
        class Agent:
            tools = []
            def __init__(self, **kwargs): calls['init'] = kwargs
            def run_conversation(self, message, **kwargs):
                calls['message'] = message; calls['turn'] = kwargs
                return {'final_response': '{"intent":"explain-recorded-status"}'}
            def close(self): closed.append(True)
        with tempfile.TemporaryDirectory(prefix='ql-hermes-fixture-') as folder:
            root=Path(folder); (root/'run_agent.py').touch()
            secret=root/'key';secret.write_text('fictional-fixture-credential');secret.chmod(0o600)
            home=root/'fresh-home';home.mkdir(mode=0o700)
            import os
            original=os.environ.get('HERMES_HOME')
            try:
                intent=self.w.run_hermes_turn(payload(),source_root=root,credential_file=str(secret),
                    model='fixture',base_url='https://model.invalid/v1',home=home,agent_factory=Agent)
            finally:
                if original is None: os.environ.pop('HERMES_HOME',None)
                else: os.environ['HERMES_HOME']=original
        self.assertEqual(intent,'explain-recorded-status');self.assertEqual(closed,[True])
        options=calls['init']
        self.assertEqual(options['enabled_toolsets'],[])
        for option in ('skip_context_files','skip_memory','skip_background_review'):
            self.assertIs(options[option],True)
        for option in ('load_soul_identity','save_trajectories','verbose_logging'):
            self.assertIs(options[option],False)
        self.assertEqual(options['max_iterations'],2)
        self.assertLess(options['run_budget_seconds'],30)
        self.assertIsNone(options['fallback_model']);self.assertIsNone(options['session_db'])
        self.assertEqual(calls['turn']['conversation_history'],[])
        self.assertNotIn('fictional-fixture-credential',calls['turn']['system_message'])
        self.assertNotIn('fictional-fixture-credential',calls['message'])

    def test_upstream_cannot_enable_a_tool_or_return_financial_prose(self):
        class Agent:
            tools=[]
            output='{"intent":"paid","total":12500}'
            def __init__(self,**kwargs):pass
            def run_conversation(self,*args,**kwargs):return {'final_response':self.output}
            def close(self):pass
        with tempfile.TemporaryDirectory(prefix='ql-hermes-output-') as folder:
            root=Path(folder); (root/'run_agent.py').touch()
            key=root/'key';key.write_text('fictional-fixture-key');key.chmod(0o600)
            import os
            original=os.environ.get('HERMES_HOME')
            try:
                for output in ['{"intent":"paid","total":12500}', 'Your real funds arrived.',
                               '{"intent":"check-total","intent":"request-review"}']:
                    Agent.output=output
                    with self.assertRaises(ValueError):
                        self.w.run_hermes_turn(payload(),source_root=root,credential_file=str(key),model='fixture',
                            base_url='https://model.invalid/v1',home=root,agent_factory=Agent)
                Agent.tools=[{'function':{'name':'terminal'}}]
                with self.assertRaises(RuntimeError):
                    self.w.run_hermes_turn(payload(),source_root=root,credential_file=str(key),model='fixture',
                        base_url='https://model.invalid/v1',home=root,agent_factory=Agent)
            finally:
                if original is None:os.environ.pop('HERMES_HOME',None)
                else:os.environ['HERMES_HOME']=original

    def test_child_deadline_kills_inference_and_removes_fresh_home(self):
        import time, os
        with tempfile.TemporaryDirectory(prefix='ql-hermes-deadline-') as folder:
            root=Path(folder);root.chmod(0o700)
            state=root/'state';state.mkdir(mode=0o700)
            key=root/'key';key.write_text('fictional-fixture-key');key.chmod(0o600)
            interpreter=root/'slow-python'
            interpreter.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(10)\n')
            interpreter.chmod(0o700)
            inference=self.w.ChildInference(source_root=root,credential_file=str(key),model='fixture',
                base_url='https://model.invalid/v1',state_dir=str(state),python=str(interpreter),deadline=0.1)
            start=time.monotonic()
            with self.assertRaises(self.w.ServiceError) as e:inference(payload())
            self.assertEqual(e.exception.status,504)
            self.assertLess(time.monotonic()-start,2)
            self.assertEqual(list(state.iterdir()),[])

    def test_duplicate_keys_nonfinite_json_and_bad_dates_are_rejected(self):
        for raw in ['{"role":"client","role":"accountant"}', '{"tax":NaN}']:
            with self.assertRaises(ValueError):self.w._strict_json(raw)
        p=payload();p['case']['asOf']='2026-02-31T12:00:00Z'
        with self.assertRaises(self.w.ServiceError):self.w.validate_request(p)

    def test_startup_rejects_an_unverified_or_personal_hermes_tree(self):
        with tempfile.TemporaryDirectory(prefix='ql-hermes-unverified-') as folder:
            root=Path(folder);(root/'run_agent.py').write_text('# unrelated public code')
            with self.assertRaises(ValueError):self.w.validate_public_source(root)
            (root/'.env').write_text('UNRELATED_FIXTURE=yes')
            with self.assertRaises(ValueError):self.w.validate_public_source(root)

if __name__ == '__main__': unittest.main()
