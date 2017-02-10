'use strict';

const IRCClient = require('./client');
const net = require('net');

class IRCServer {
	constructor(port, ident) {
		this._clients = [];
		this.ident = ident;

		const server = net.createServer(c => {
			const clt = new IRCClient(this, c);
			c.once('end', () => this._removeClient(clt));
			this._clients.push(clt);
		});

		server.listen(port);		
	}

	_removeClient(c) {
		const i = this._clients.indexOf(c);
		if (i === -1) {
			return;
		}
		this._clients.splice(i, 1);
	}
}

module.exports = new IRCServer(6667, 'hmirc.zdc.io');