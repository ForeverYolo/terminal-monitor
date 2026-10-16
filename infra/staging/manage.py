#!/usr/bin/env python3
"""Deploy and operate a separate Tencent/2080 Terminal Monitor test platform."""
import argparse, io, ipaddress, json, secrets, shlex, subprocess, tarfile, tempfile
from pathlib import Path
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = Path('/home/renhangqi/terminal-monitor-staging')

def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)

def ssh(host, user, port, command, **kwargs):
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', str(port),
                f'{user}@{host}', command], **kwargs)

def scp(host, user, port, source, destination):
    return run(['scp', '-q', '-P', str(port), str(source), f'{user}@{host}:{destination}'])

def quote(*args):
    return ' '.join(shlex.quote(str(arg)) for arg in args)

def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)

def package(ref, archive):
    commit = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', ref], text=True).strip()
    raw = subprocess.check_output(['git', '-C', str(REPO), 'archive', commit])
    deps = DEFAULT_ROOT / 'build-deps'
    if not (deps / 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js').exists():
        run(['npm', 'install', '--prefix', str(deps), 'xterm@5.3.0', 'xterm-addon-fit@0.8.0'])
    with tarfile.open(fileobj=io.BytesIO(raw)) as source, tarfile.open(archive, 'w:gz') as target:
        for entry in source:
            data = source.extractfile(entry).read() if entry.isfile() else None
            if entry.name == 'public/index.html':
                html = data.decode().replace('<title>Terminal Monitor</title>', '<title>Terminal Monitor · 测试</title>')
                html = html.replace('<h1>Terminal Monitor</h1>', '<h1>Terminal Monitor · 测试</h1>')
                html = html.replace("|| 'zzb'", "|| 'test'")
                html = html.replace('https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css', '/vendor/xterm.css')
                html = html.replace('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js', '/vendor/xterm.js')
                html = html.replace('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js', '/vendor/xterm-addon-fit.js')
                data = html.encode(); entry.size = len(data)
            elif entry.name in ['public/connection.js', 'public/bootstrap.js']:
                data = data.decode().replace("|| 'zzb'", "|| 'test'").encode(); entry.size = len(data)
            target.addfile(entry, io.BytesIO(data) if data is not None else None)
        extras = {
            'public/vendor/xterm.css': (deps / 'node_modules/xterm/css/xterm.css').read_bytes(),
            'public/vendor/xterm.js': (deps / 'node_modules/xterm/lib/xterm.js').read_bytes(),
            'public/vendor/xterm-addon-fit.js': (deps / 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js').read_bytes(),
            'public/staging.json': json.dumps({'environment':'staging','commit':commit,'deployedAt':datetime.now(timezone.utc).isoformat(),'client':'2080','nativeTui':True}).encode(),
        }
        for name, data in extras.items():
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644
            target.addfile(entry, io.BytesIO(data))
    return commit

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy','status','start','stop'])
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--server-host', default='82.157.107.218')
    parser.add_argument('--server-user', default='ubuntu')
    parser.add_argument('--server-root', default='/home/ubuntu/terminal-monitor-staging')
    parser.add_argument('--server-port', type=int, default=18080)
    parser.add_argument('--client-host', default='162.105.175.7')
    parser.add_argument('--client-user', default='renhangqi')
    parser.add_argument('--client-ssh-port', type=int, default=6007)
    parser.add_argument('--client-root', default=str(DEFAULT_ROOT))
    parser.add_argument('--client-node', default='/home/renhangqi/.nvm/versions/node/v20.20.2/bin/node')
    parser.add_argument('--task-proxy', default='http://127.0.0.1:7890', help='2080 proxy for Codex account/API requests')
    args = parser.parse_args()
    try:
        ipaddress.IPv4Address(args.server_host)
    except ValueError:
        parser.error('--server-host must be an IPv4 address')
    for root in [args.server_root, args.client_root]:
        # Restrict the managed paths, including cron/shell template arguments.
        if not root.startswith('/') or not root.endswith('/terminal-monitor-staging') or any(c not in '/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in root):
            parser.error('roots must be absolute simple paths ending in /terminal-monitor-staging')
    if args.action == 'status':
        ssh(args.server_host,args.server_user,22,'systemctl is-active terminal-monitor-staging.service; systemctl show terminal-monitor-staging.service -p MainPID -p NRestarts')
        ssh(args.client_host,args.client_user,args.client_ssh_port,quote('bash','-c',f'screen -ls; test ! -f {shlex.quote(args.client_root)}/runtime/stopped'))
        return
    if args.action in ['start','stop']:
        if args.action == 'stop':
            ssh(args.client_host,args.client_user,args.client_ssh_port,quote('bash',args.client_root+'/bin/stop-client.sh'))
            ssh(args.server_host,args.server_user,22,'sudo -n systemctl stop terminal-monitor-staging.service')
        else:
            ssh(args.server_host,args.server_user,22,'sudo -n systemctl start terminal-monitor-staging.service')
            ssh(args.client_host,args.client_user,args.client_ssh_port,quote('bash','-c',f'rm -f {args.client_root}/runtime/stopped; bash {args.client_root}/bin/ensure-client.sh'))
        return
    private = DEFAULT_ROOT / 'runtime'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    access_file = private / 'access.json'
    if access_file.exists():
        access = json.loads(access_file.read_text())
    else:
        access = {'url':f'http://{args.server_host}/','username':'test','password':secrets.token_urlsafe(18),'token':secrets.token_urlsafe(32)}
        write_private(access_file, access)
    access['url'] = f'http://{args.server_host}/'
    write_private(access_file, access)
    with tempfile.TemporaryDirectory(prefix='swt-staging-deploy-') as temp:
        temp = Path(temp)
        archive = temp / 'release.tar.gz'
        commit = package(args.ref, archive)
        release = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '-' + commit[:8]
        server_cfg = temp / 'server.json'; client_cfg = temp / 'client.json'; settings = temp / 'settings.json'
        write_private(server_cfg, {'mode':'server','server':{'host':'127.0.0.1','port':args.server_port,'password':access['password'],'tokens':{access['token']:{'name':'staging-2080','user':access['username']}},'maxAgents':10,'supervisor':{'enabled':False}}})
        write_private(client_cfg, {'mode':'client','client':{'serverUrl':f'ws://{args.server_host}/','token':access['token'],'name':'2080 · Codex 原生 TUI 测试','screen':'swt-staging-codex','screenMode':'auto','clientId':'staging-2080','nativeTui':True,'fileRoot':args.client_root+'/runtime/sandbox','attrs':{'tags':['staging','2080','native-tui']}}})
        task_environment = {key:args.task_proxy for key in ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']} if args.task_proxy else {}
        task_environment.update({'NO_PROXY':f'localhost,127.0.0.1,{args.server_host}', 'no_proxy':f'localhost,127.0.0.1,{args.server_host}'})
        write_private(settings, {'node':args.client_node,'release':release,'commit':commit,'taskEnvironment':task_environment})
        for host,user,port,root,cfg in [(args.server_host,args.server_user,22,args.server_root,server_cfg),(args.client_host,args.client_user,args.client_ssh_port,args.client_root,client_cfg)]:
            ssh(host,user,port,quote('mkdir','-p',root+'/releases/'+release,root+'/runtime'))
            ssh(host,user,port,quote('chmod','700',root+'/runtime'))
            scp(host,user,port,archive,root+'/releases/'+release+'/release.tar.gz')
            ssh(host,user,port,quote('tar','-xzf',root+'/releases/'+release+'/release.tar.gz','-C',root+'/releases/'+release))
            scp(host,user,port,cfg,root+'/runtime/'+cfg.name)
            ssh(host,user,port,quote('chmod','600',root+'/runtime/'+cfg.name))
        scp(args.client_host,args.client_user,args.client_ssh_port,settings,args.client_root+'/runtime/settings.json')
        ssh(args.server_host,args.server_user,22,quote('bash',args.server_root+'/releases/'+release+'/infra/staging/install-server.sh',args.server_root,release,args.server_host,args.server_port))
        ssh(args.client_host,args.client_user,args.client_ssh_port,quote('bash',args.client_root+'/releases/'+release+'/infra/staging/install-client.sh',args.client_root,release,args.client_node))
        write_private(private/'deployment.json',{'release':release,'commit':commit,'serverRoot':args.server_root,'clientRoot':args.client_root,'url':access['url']})
        print(f'Deployed {commit[:8]} to {access["url"]}; login details: {access_file}')

if __name__ == '__main__':
    main()
