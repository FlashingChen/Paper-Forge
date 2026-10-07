#!/usr/bin/env python3
"""Run on the operator's machine. Remote operations are Docker commands only."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--scope', choices=['beta', 'main'], default='beta')
parser.add_argument('--user', default='root')
parser.add_argument('--port', type=int, default=22)
parser.add_argument('--control-path', help='Existing SSH control socket; passwords are never command arguments')
parser.add_argument('--known-hosts', help='An existing operator-side known_hosts file')
parser.add_argument('--env-file', type=Path, required=True)
parser.add_argument('--manager-image', required=True)
parser.add_argument('--agent-image', required=True)
parser.add_argument('--docker-bin', default='docker')
parser.add_argument('--update', action='store_true', help='Replace only the owned scoped manager; retain old container and all volumes')
parser.add_argument('--images-present', action='store_true', help='Use explicitly prebuilt images already on the node; verify architecture')
parser.add_argument('--execute', action='store_true', help='Without this flag only checks Docker and prints the deployment plan')
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.host) or not re.fullmatch(r'[A-Za-z0-9_-]+', args.user):
    sys.exit('Invalid SSH destination')
ssh = ['ssh', '-p', str(args.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
if args.control_path:
    ssh += ['-S', args.control_path]
if args.known_hosts:
    ssh += ['-o', 'UserKnownHostsFile=' + args.known_hosts]
ssh += [args.user + '@' + args.host]

def remote(*parts, data=None):
    result = subprocess.run(ssh + [shlex.join([args.docker_bin, *parts])], input=data, capture_output=True)
    if result.returncode:
        # Do not echo Docker errors that might include environment values.
        sys.exit('Remote Docker command failed (exit %s). No host installation or cleanup was attempted.' % result.returncode)
    return result.stdout

def inspect_local(image):
    result = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True, check=True)
    return json.loads(result.stdout)[0]

values = {}
for line in args.env_file.read_text().splitlines():
    if line and not line.startswith('#'):
        key, value = line.split('=', 1)
        if not re.fullmatch(r'PAPERFORGE_(NODE_[A-Z_]+|AGENT_[A-Z_]+|CONTROL_URL)', key):
            sys.exit('Node env file contains unexpected keys')
        values[key] = value
prefix = values.get('PAPERFORGE_NODE_VOLUME', '')
node_id = values.get('PAPERFORGE_NODE_ID', '')
if not re.fullmatch(rf'paperforge-{args.scope}-[a-z0-9-]{{1,64}}', prefix) or not re.fullmatch(r'[a-z0-9-]{1,48}', node_id):
    sys.exit('Invalid PaperForge node/volume prefix')
if len(values.get('PAPERFORGE_NODE_TOKEN', '')) < 32:
    sys.exit('Missing node token')
if values.get('PAPERFORGE_AGENT_IMAGE') != args.agent_image:
    sys.exit('Agent image differs from the node env file')
info = json.loads(remote('info', '--format', '{{json .}}'))
arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(info['Architecture'], info['Architecture'])
for image in [args.agent_image, args.manager_image]:
    if inspect_local(image)['Architecture'] != arch:
        sys.exit('Image architecture does not match node: ' + arch)
if info['MemTotal'] < 3 * 1024**3:
    sys.exit('Less than 3 GiB memory detected; review task memory before deployment')
name = f'paperforge-{args.scope}-node-manager'
existing = json.loads(remote('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', 'json').decode() or '{}')
if existing:
    if not args.update: sys.exit('Manager exists; pass --update to retain and replace only the scoped manager')
    details=json.loads(remote('inspect', name))[0]
    if any(details['Config']['Labels'].get(k)!=v for k,v in {'paperforge.scope':args.scope,'paperforge.node':node_id,'paperforge.role':'manager'}.items()): sys.exit('Manager ownership mismatch')
elif args.update:
    sys.exit('No owned manager exists to update')
volume = prefix + '-state'
listed = remote('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}').decode().strip()
if listed:
    if not args.update: sys.exit('State volume exists; explicit update required')
    details=json.loads(remote('volume','inspect',volume))[0]
    if details['Labels'].get('paperforge.scope')!=args.scope or details['Labels'].get('paperforge.node')!=node_id: sys.exit('State ownership mismatch')
print(json.dumps({'node': node_id, 'cpus': info['NCPU'], 'memory_gib': round(info['MemTotal']/1024**3, 1),
                  'architecture': arch, 'manager': name, 'state_volume': volume, 'execute': args.execute}))
if not args.execute:
    sys.exit(0)
# Transfer only images. An explicitly prebuilt node image may reuse verified
# existing base layers without uploading a second copy of the Python/pi runtime.
if args.images_present:
    for image in [args.agent_image,args.manager_image]:
        found=json.loads(remote('image','inspect',image))[0]
        if found['Architecture']!=arch: sys.exit('Remote image architecture mismatch')
else:
    save = subprocess.Popen(['docker', 'save', args.agent_image, args.manager_image], stdout=subprocess.PIPE)
    load = subprocess.run(ssh + [shlex.join([args.docker_bin, 'load'])], stdin=save.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    save.stdout.close()
    if load.returncode or save.wait(): sys.exit('Image transfer failed; no data cleanup attempted')
if not listed:
    remote('volume', 'create', '--label', 'paperforge.scope='+args.scope, '--label', 'paperforge.node=' + node_id,
           '--label', 'paperforge.role=manager-state', volume)
if existing:
    remote('stop','--time','15',name)
    remote('rename',name,name+'-before-'+str(__import__('time').time_ns()))
values['PAPERFORGE_NODE_SCOPE']=args.scope
env_data=''.join(k+'='+v+'\n' for k,v in values.items()).encode()
remote('run', '-d', '--name', name, '--restart', 'unless-stopped', '--env-file', '/dev/stdin',
       '--label', 'paperforge.scope='+args.scope, '--label', 'paperforge.node=' + node_id, '--label', 'paperforge.role=manager',
       '--memory', '256m', '--cpus', '0.25', '--pids-limit', '64', '--cap-drop', 'ALL',
       '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,noexec,size=16m',
       '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
       '--mount','type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
       '--mount', 'type=volume,src=' + volume + ',dst=/state', args.manager_image, data=env_data)
print('Manager updated. Old manager, images and task volumes retained.')
