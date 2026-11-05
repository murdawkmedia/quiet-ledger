"""Fixed-target SHC backup runner. Never reads or logs application key values."""
import datetime,fcntl,json,os,re,shutil,stat,subprocess
from pathlib import Path

ROOT=Path('/opt/quiet-ledger')
NAME=re.compile(r'quiet-ledger-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.qlb')
MAX_ARCHIVE=64*1024**2+32

def retention_candidates(directory,uid,keep):
    if keep<1 or directory.is_symlink() or directory.resolve()!=directory:raise ValueError('Unsafe backup directory.')
    found=[]
    for path in directory.iterdir():
        if not NAME.fullmatch(path.name):continue
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or not 32<=info.st_size<=MAX_ARCHIVE:raise ValueError('Unsafe backup entry.')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as stream:
            if stream.read(4)!=b'QLB\x01':raise ValueError('Unexpected archive header.')
        found.append(path)
    return sorted(found)[:-keep]

def command(args):
    done=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,check=True,text=True)
    if len(done.stdout)>10000:raise ValueError('Unexpected backup response.')
    return json.loads(done.stdout)

def main():
    if os.geteuid()!=0 or ROOT.is_symlink() or ROOT.resolve()!=ROOT or (ROOT/'.task-marker').read_text()!='quiet-ledger-hosted-2026-11-04\n':raise ValueError('Unrecognized deployment.')
    directory=ROOT/'backups'
    info=directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=1000 or stat.S_IMODE(info.st_mode)!=0o700:raise ValueError('Unsafe backup directory.')
    # Preflight entries before any new work; never prune unfamiliar/bad entries.
    retention_candidates(directory,1000,7)
    if shutil.disk_usage(ROOT).free<2*1024**3+256*1024**2:raise ValueError('Backup capacity floor reached.')
    with (ROOT/'.backup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        result=command(['docker','exec','quiet-ledger-app','node','ops/backup.js','backup'])
        if not isinstance(result,dict) or not NAME.fullmatch(result.get('file','')):raise ValueError('Unexpected backup result.')
        check=command(['docker','exec','-e','BACKUP_FILE=/backups/'+result['file'],'quiet-ledger-app','node','ops/backup.js','verify'])
        if check.get('integrity')!='ok':raise ValueError('Backup verification failed.')
        old=retention_candidates(directory,1000,7)
        if directory/result['file'] in old:raise ValueError('New archive unexpectedly expired.')
        for path in old:path.unlink()
        result.update(check)
        result.update(verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),retained=len([p for p in directory.iterdir() if NAME.fullmatch(p.name)]),pruned=len(old))
        staged=ROOT/'.backup-status.tmp'
        fd=os.open(staged,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(result,stream);stream.flush();os.fsync(stream.fileno())
        staged.replace(ROOT/'backup-status.json')
        print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Quiet Ledger backup failed; inspect service status and capacity privately.')
