"""Install the reviewed app release; preserve unrelated front-door routes and services."""
import argparse,datetime,hashlib,json,os,re,shutil,stat,subprocess,time
from pathlib import Path
ROOT=Path('/opt/quiet-ledger')
CADDY=Path('/opt/shc-frontdoor/Caddyfile')
MARKER='quiet-ledger-hosted-2026-11-04\n'
BEGIN=b'# BEGIN quiet-ledger managed route'
END=b'# END quiet-ledger managed route'
FLOOR=2*1024**3
APP_BASE_REVISION='c61f97464ef26b03'
HERMES_IMAGE='quiet-ledger-hermes-demo:0.22.5'
# The target Docker load uses the immutable config digest; the local containerd
# descriptor differs. Every rootfs layer and defined Config field was verified equal.
HERMES_IMAGE_ID='sha256:a71177dba1178352058b08cdcbd90982b6c5b97ea3075ab28d62cabe33907701'
WN_BINARY_SHA256='08c346d09bbc0a68d5f47c61f393a91245fb82cf40ea17898b2ecdd189d12964'
RUNTIME_UID=1000

def argument_parser():
    parser=argparse.ArgumentParser()
    for option in ['revision','public-origin','backend-host','expected-host']:parser.add_argument('--'+option,required=True)
    parser.add_argument('--enable-hackathon-demo',action='store_true')
    parser.add_argument('--enable-demo-team',action='store_true')
    parser.add_argument('--base-revision',choices=[APP_BASE_REVISION])
    parser.add_argument('--build-reserve-mib',type=int,choices=[256,512,1024],default=1024)
    parser.add_argument('--reuse-app-image',action='store_true')
    return parser

def preflight_options(args,free_bytes):
    if args.base_revision not in [None,APP_BASE_REVISION]:raise ValueError('Unreviewed incremental base revision.')
    if args.build_reserve_mib not in [256,512,1024]:raise ValueError('Unreviewed build reserve.')
    if args.enable_demo_team and not args.enable_hackathon_demo:raise ValueError('Demo team requires explicit hackathon demo approval.')
    reserve=0 if args.reuse_app_image else args.build_reserve_mib*1024**2
    if free_bytes-reserve<=FLOOR:raise ValueError('Capacity floor is not met.')

def app_build_command(args,release):
    result=['docker','build']
    if args.base_revision:result+=['--build-arg','BASE_IMAGE=quiet-ledger:'+args.base_revision]
    return result+['--tag','quiet-ledger:'+args.revision,str(release)]

def render_environment(before,revision,public_origin,backend_host,hackathon,team):
    if not isinstance(before,str) or '\0' in before or len(before)>1024*1024:raise ValueError('Invalid existing environment file.')
    replacements={'APP_REVISION':revision,'PUBLIC_ORIGIN':public_origin,'BACKEND_HOST':backend_host}
    if hackathon:replacements['HACKATHON_DEMO_ENABLED']='true'
    elif not re.search(r'(?m)^HACKATHON_DEMO_ENABLED=',before):replacements['HACKATHON_DEMO_ENABLED']='false'
    if team:replacements['DEMO_TEAM_ENABLED']='true'
    lines=[];seen=set()
    for line in before.splitlines():
        match=re.match(r'^([A-Z][A-Z0-9_]*)=',line)
        if match:
            key=match[1]
            if key in seen:raise ValueError('Duplicate environment setting; preserve for review.')
            seen.add(key)
            if key in replacements:line=key+'='+replacements.pop(key)
        lines.append(line)
    lines.extend(key+'='+value for key,value in replacements.items())
    return '\n'.join(lines)+'\n'

def private_feature_path(path,directory=False):
    if not path.is_absolute() or any(ancestor.is_symlink() for ancestor in [path,*path.parents]):raise ValueError('Unsafe demo feature path.')
    info=path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) or info.st_uid!=RUNTIME_UID or stat.S_IMODE(info.st_mode)!=(0o700 if directory else 0o600) or (not directory and (info.st_nlink!=1 or not 1<=info.st_size<=16384)):raise ValueError('Demo feature requires private runtime-owned paths.')

def validate_demo_team(root):
    private_feature_path(root/'demo-team',True)
    private_feature_path(root/'hermes-secrets',True)
    private_feature_path(root/'secrets/hermes-worker-token')
    private_feature_path(root/'hermes-secrets/model-credential')
    token=(root/'secrets/hermes-worker-token').read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',token):raise ValueError('Invalid private worker credential.')
    binary=root/'tools/wn-agent'
    if any(path.is_symlink() for path in [binary,*binary.parents]):raise ValueError('Unsafe native demo executable.')
    info=binary.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in [0,RUNTIME_UID] or not info.st_mode&0o111 or info.st_mode&0o022 or info.st_nlink!=1 or hashlib.sha256(binary.read_bytes()).hexdigest()!=WN_BINARY_SHA256:raise ValueError('Pinned native demo executable verification failed.')
    image=json.loads(subprocess.check_output(['docker','image','inspect','--format','{{json .}}',HERMES_IMAGE]))
    if image.get('Id')!=HERMES_IMAGE_ID:raise ValueError('Pinned Hermes demo image is unavailable.')

def require_local_image(name):
    value=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',name],text=True).strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',value):raise ValueError('Reviewed local image is unavailable.')
    return value


def managed_config(before,host):
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{1,200})[a-z0-9]',host):raise ValueError('Invalid backend hostname.')
    route=(BEGIN.decode()+'\n'+host+' {\n  encode zstd gzip\n  request_body {\n    max_size 48KB\n  }\n  header {\n    -Server\n    Cache-Control "no-store"\n    Referrer-Policy "no-referrer"\n    X-Content-Type-Options "nosniff"\n  }\n  reverse_proxy quiet-ledger:4317\n}\n'+END.decode()).encode()
    if before.count(BEGIN)!=before.count(END) or before.count(BEGIN)>1:raise ValueError('Ambiguous managed route.')
    if BEGIN in before:
        a=before.index(BEGIN);b=before.index(END)+len(END)
        return before[:a]+route+before[b:]
    if re.search(rb'(?m)^'+re.escape(host.encode())+rb'\s*\{',before):raise ValueError('Existing unmanaged hostname; stop.')
    return before+(b'' if before.endswith(b'\n') else b'\n')+b'\n'+route+b'\n'

def write_bound(path,data,expected):
    if path.read_bytes()!=expected:raise RuntimeError('Concurrent configuration change; preserved for review.')
    # Preserve the bind-mounted inode used by the shared Caddy container.
    with path.open('r+b') as f:f.seek(0);f.write(data);f.truncate();f.flush();os.fsync(f.fileno())

def phase(name,**values):print(json.dumps({'phase':name,**values}),flush=True)
def run(args,log):
    with log.open('ab') as stream:
        result=subprocess.run(args,stdout=stream,stderr=subprocess.STDOUT)
    if result.returncode:raise RuntimeError('Deployment command failed; inspect the private deployment log.')

def main():
    args=argument_parser().parse_args()
    from urllib.parse import urlsplit
    url=urlsplit(args.public_origin)
    assert os.geteuid()==0 and os.uname().nodename==args.expected_host,'Unexpected deployment host/user.'
    assert re.fullmatch(r'[0-9a-f]{16}',args.revision),'Invalid content revision.'
    assert url.scheme=='https' and url.netloc and not url.username and not url.password and not url.path and not url.query and not url.fragment,'Invalid public origin.'
    assert ROOT.is_dir() and not ROOT.is_symlink() and (ROOT/'.task-marker').read_text()==MARKER,'Unrecognized app root.'
    preflight_options(args,shutil.disk_usage(ROOT).free)
    release=ROOT/'releases'/args.revision;assert release.is_dir() and release.resolve()==release,'Missing reviewed release.'
    manifest=json.loads((release/'release-manifest.json').read_text())
    for name,digest in manifest['backend_files'].items():
        path=release/name;assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(release) and hashlib.sha256(path.read_bytes()).hexdigest()==digest,'Release mismatch.'
    if args.enable_demo_team:
        assert 'compose-demo.yml' in manifest['backend_files'],'Demo override is not in the reviewed release manifest.'
        validate_demo_team(ROOT)
    if args.reuse_app_image:require_local_image('quiet-ledger:'+args.revision)
    elif args.base_revision:require_local_image('quiet-ledger:'+args.base_revision)
    old_env=(ROOT/'.env').read_text() if (ROOT/'.env').exists() else ''
    new_env=render_environment(old_env,args.revision,args.public_origin,args.backend_host,args.enable_hackathon_demo,args.enable_demo_team)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');log=ROOT/('deploy-'+stamp+'.log');log.touch(mode=0o600)
    before=CADDY.read_bytes();updated=managed_config(before,args.backend_host)
    recovery=ROOT/'recovery';recovery.mkdir(mode=0o700,exist_ok=True)
    saved=recovery/('caddy-before-'+stamp+'.conf');fd=os.open(saved,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'wb') as f:f.write(before)
    for name in ['compose.yml','compose.demo.yml','.env']:
        p=ROOT/name
        if p.exists():
            snapshot=recovery/(name.replace('.','_')+'-before-'+stamp)
            descriptor=os.open(snapshot,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(descriptor,'wb') as stream:stream.write(p.read_bytes())
    (ROOT/'compose.yml').write_bytes((release/'compose.yml').read_bytes())
    if args.enable_demo_team:(ROOT/'compose.demo.yml').write_bytes((release/'compose-demo.yml').read_bytes())
    (ROOT/'.env').write_text(new_env);os.chmod(ROOT/'.env',0o600)
    if args.reuse_app_image:phase('reusing-reviewed-image',revision=args.revision)
    else:
        phase('building-image',revision=args.revision,free_bytes=shutil.disk_usage(ROOT).free,reserve_mib=args.build_reserve_mib)
        run(app_build_command(args,release),log)
    assert shutil.disk_usage(ROOT).free>FLOOR,'Capacity floor reached; new writes stopped.'
    phase('starting-isolated-backend')
    compose=['docker','compose','--project-directory',str(ROOT),'-f',str(ROOT/'compose.yml')]
    if args.enable_demo_team:compose+=['-f',str(ROOT/'compose.demo.yml')]
    run(compose+['up','-d','--no-build'],log)
    for _ in range(90):
        status=subprocess.check_output(['docker','inspect','--format','{{.State.Health.Status}}','quiet-ledger-app'],text=True).strip()
        if status=='healthy':break
        if status=='unhealthy':raise RuntimeError('The isolated backend is unhealthy.')
        time.sleep(.5)
    else:raise RuntimeError('Backend readiness did not settle.')
    phase('validating-new-frontdoor-route')
    write_bound(CADDY,updated,before)
    try:
        run(['docker','exec','shc-frontdoor-caddy-1','caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],log)
        run(['docker','exec','shc-frontdoor-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],log)
    except Exception:
        write_bound(CADDY,before,updated)
        run(['docker','exec','shc-frontdoor-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],log)
        raise
    result={'revision':args.revision,'public_origin':args.public_origin,'backend_host':args.backend_host,'backend_health':'healthy','hackathon_demo_enabled':'HACKATHON_DEMO_ENABLED=true' in new_env.splitlines(),'demo_team_enabled':args.enable_demo_team,'base_revision':args.base_revision,'reused_app_image':args.reuse_app_image,'caddy_before_sha256':hashlib.sha256(before).hexdigest(),'caddy_after_sha256':hashlib.sha256(updated).hexdigest(),'sibling_routes_preserved':True,'free_bytes':shutil.disk_usage(ROOT).free,'timestamp':stamp}
    (ROOT/'deployment.json').write_text(json.dumps(result,indent=2)+'\n');phase('backend-installed',**result)
if __name__=='__main__':main()
