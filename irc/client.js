'use strict';

const Promise = require('bluebird');
const APIClient = require('../hmapi/index');

function emitLines (stream) {
	let backlog = ''
	stream.on('data', data => {
		backlog += data;
		let n = backlog.indexOf('\n');
		while (n !== -1) {
			stream.emit('line', backlog.substring(0, n));
			backlog = backlog.substring(n + 1);
			n = backlog.indexOf('\n');
		}
	});
	stream.on('end', () => {
		if (backlog) {
			stream.emit('line', backlog);
		}
	});
}

class IRCClient {
	constructor (server, socket) {
		this.server = server;
		this.socket = socket;
		
		this.apiClient = new APIClient();
		this.loggedIn = false;
		this.isWelcomed = false;

		this.channels = [];
		this.nick = null;
		this._lastValidNick = null;
		this.ident = null;
		this.fullIdent = null;

		this._selfMessages = [];

		this._lineQueue = [];
		this._lineQueueProcessing = false;

		this._pollInterval = setInterval(() => this._pollMessages(), 1000);

		emitLines(socket);
		socket.on('line', l => {
			const split = l.split(' ');
			const cmd = split.splice(0, 1)[0];
			let colonIdx = -1;

			for (let i = 0; i < split.length; i++) {
				let v = split[i];
				if (v.charAt(0) === ':') {
					v = v.substr(1);
					if (i + 1 < split.length) {
						const rest = split.splice(i + 1);
						v += ` ${rest.join(' ')}`;
					}
					split[i] = v;
					break;
				}
			}

			this._lineQueue.push({ cmd, split });
			this._processQueue();
		});

		socket.once('end', () => clearInterval(this._pollInterval));
		socket.on('error', () => socket.end());
	}

	_pollMessages() {
		if (!this.isWelcomed) {
			return;
		}

		return this.apiClient.pollMessages()
		.each(message => {
			const from = `${message.from_user}!${message.from_user}@hackmud.trustnet`;
			const to = message.channel ? `#${message.channel}` : message.to_user;
			let msg = message.msg;

			if (message.channel && !this.channels[to]) {
				this.joinTo(to);
			}

			msg = msg.replace(/[\u0001\u0002\r]/g, '');

			const i = this._selfMessages.indexOf(`${to}|${msg}`);
			if (i !== -1) {
				this._selfMessages.splice(i, 1);
				return;
			}

			msg = msg.split('\n');

			if (message.from_user === this.nick && message.to_user) {
				if (message.to_user === this.nick) {
					return;
				}
				msg.forEach(m => this.sendRaw(`${message.to_user}!${message.to_user}@hackmud.trustnet`, 'PRIVMSG', this.nick, `\u0001ACTION [SELF] ${m}\u0001`));
				return;
			}


			msg.forEach(m => this.sendRaw(from, 'PRIVMSG', to, m));
		})
		.catch(e => {
			console.error(e.stack || e);
		});
	}

	_processQueue() {
		if (this._lineQueueProcessing) {
			return;
		}

		const entry = this._lineQueue.shift();
		if (entry) {
			this._lineQueueProcessing = true;
			return Promise.resolve(this.onCommand(entry.cmd.toUpperCase(), entry.split))
			.finally(() => {
				this._lineQueueProcessing = false;
				this._processQueue();
			});
		}
	}

	onCommand(cmd, args) {
		switch (cmd) {
			case 'PASS':
				return this.apiClient.login(args[0])
				.then(() => {
					this.loggedIn = true;
					return this.checkReady(false);
				})
				.catch(e => {
					console.error(e.stack || e);
					this.sendPasswordIncorrect();
				});
			case 'NICK':
				this.nick = args[0];
				return this.checkReady();
			case 'USER':
				if (this.ident) {
					return;
				}
				this.ident = args[0]; 
				return this.checkReady();
			case 'PING':
				return this.sendRawFromServer('PONG', args[0]);
			case 'PRIVMSG':
				if (!this.isWelcomed) {
					return;
				}

				const pmsgTo = args[0];
				let msg = args[1];

				if (msg.charCodeAt(0) === 1 || msg.charCodeAt(0) === 2) {
					if (msg.substr(1, 6).toUpperCase() !== 'ACTION') {
						return;
					}
					msg = '*' + msg.substring(8, msg.length - 1) + '*';
				}

				let p;
				if (pmsgTo.charAt(0) === '#') {
					p = this.apiClient.sendChatToChannel(pmsgTo.substr(1), msg);
				} else {
					p = this.apiClient.sendChatToUser(pmsgTo, msg);
				}
				return p
					.then(() => {
						this._selfMessages.push(`${pmsgTo}|${msg}`);
					})
					.catch(e => {
						console.warn(e.stack || e);
					});
			case 'MODE':
			case 'QUIT':
				return;
			case 'NAMES':
				return this.sendChannelNames(args[0]);
			case 'JOIN':
				// TODO: Wait for Sean
				const jchan = args[0];
				if (this.channels[jchan]) {
					return;
				}
				return this.sendRawFromServer('475', this.formatNickForNumeric(), 'Cannot join channel (+k)');
			case 'PART':
				// TODO: Wait for Sean
				const pchan = args[0];
				if (!this.channels[pchan]) {
					return;
				}
				return this.joinTo(pchan);
			default:
				console.log(cmd, args);
		}
	}

	sendPasswordIncorrect() {
		return this.sendRawFromServer('464', this.formatNickForNumeric(), 'Password incorrect');
	}

	formatNickForNumeric() {
		return this.nick || '*';
	}

	checkReady(canPassIncorrect = true) {
		if (canPassIncorrect && !this.loggedIn) {
			return this.sendPasswordIncorrect();
		}

		if (this.nick && this.ident && this.loggedIn) {
			this._oldFullIdent = this.fullIdent;
			this.fullIdent = `${this.nick}!${this.ident}@hackmud.trustnet`;

			return this.apiClient.setUsername(this.nick)
			.then(channels => {
				const wasUserSwap = (this.nick !== this._lastValidNick);
				this._lastValidNick = this.nick;

				if (!this.isWelcomed) {
					this.isWelcomed = true;
					this.sendRawFromServer('001', this.formatNickForNumeric(), 'Welcome to the Hackmud Chat Gateway');
					this.sendRawFromServer('002', this.formatNickForNumeric(), 'Your host is ' + this.server.ident + ', running version zdc-hackmud-chat-0.0.1');
					this.sendRawFromServer('003', this.formatNickForNumeric(), 'This server was created ' + this.server.start);
					this.sendRawFromServer('004', this.formatNickForNumeric(), this.server.ident, 'zdc-hackmud-chat-0.0.1', 'inkvo', 'inkvo', 'inkvo');

					this.sendRaw('*system', 'NOTICE', this.nick, 'Your persistent token (you can also use this as server password) is ' + this.apiClient.token);
				}

				if (wasUserSwap) {
					if (this._oldFullIdent) {
						this.sendRaw(this._oldFullIdent, 'NICK', this.nick);
					}
					this._selfMessages = [];
					Object.keys(this.channels).forEach(c => this.leaveFrom(c));
					channels.forEach(c => this.joinTo(c));
				}
			})
			.catch(e => {
				this.nick = this._lastValidNick;
				return this.sendRawFromServer('432', this.formatNickForNumeric(), 'Erroneous Nickname');
			});
		}
	}

	leaveFrom(channel) {
		if (channel.charAt(0) !== '#') {
			channel = `#${channel}`;
		}
		delete this.channels[channel];
		return this.sendRaw('*system!system@hackmud.trustnet', 'KICK', channel, this.nick, 'You are not in this channel anymore');
	}

	joinTo(channel) {
		if (channel.charAt(0) !== '#') {
			channel = `#${channel}`;
		}
		this.channels[channel] = true;
		this.sendRawFromSelf('JOIN', channel);
		return this.sendChannelNames(channel);
	}

	sendChannelNames(channel) {
		this.sendRawFromServer('353', this.formatNickForNumeric(), '@', channel, this.nick);
		this.sendRawFromServer('366', this.formatNickForNumeric(), channel, 'End of /NAMES list');
	}

	kill(sendError = true) {
		if (sendError) {
			this.sendError('Closing link');
		}
		this.socket.end();
	}

	sendRawFromSelf(type, ...args) {
		return this.sendRawFromClient(this, type, ...args);
	}

	sendRawFromClient(client, type, ...args) {
		return this.sendRaw(client.fullIdent, type, ...args);
	}

	sendRawFromServer(type, ...args) {
		return this.sendRaw(this.server.ident, type, ...args);
	}

	sendRaw(source, type, ...args) {
		if (args[args.length - 1].includes(' ')) {
			args[args.length - 1] = `:${args[args.length - 1]}`;
		}
		this.sendLine(`:${source} ${type.toUpperCase()} ${args.join(' ')}`);
	}

	sendRawD(source, type, ...args) {
		if (args[args.length - 1].includes(' ')) {
			args[args.length - 1] = `:${args[args.length - 1]}`;
		}
		console.log(`:${source} ${type.toUpperCase()} ${args.join(' ')}`);
	}

	sendError(err) {
		return this.sendCommand('ERROR', err);
	}

	sendCommand(cmd, ...args) {
		if (args[args.length - 1].includes(' ')) {
			args[args.length - 1] = `:${args[args.length - 1]}`;
		}
		this.sendLine(`${cmd.toUpperCase()} ${args.join(' ')}`);
	}

	sendLine(data) {
		try {
			return this.socket.write(`${data}\n`);
		} catch(e) { }
	}
}

module.exports = IRCClient;
