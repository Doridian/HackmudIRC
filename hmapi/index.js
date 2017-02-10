'use strict';

const Promise = require('bluebird');
const request = Promise.promisify(require('request'));

function sendAPI(method, params) {
	return request({
			url: `https://www.hackmud.com/mobile/${method}.json`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: params,
			json: true,
		})
		.then(res => res.body)
		.then(res => {
			if (!res.ok) {
				throw new Error('Res is not OK ' + JSON.stringify(res));
			}
			return res;
		});
}

const ADJUST_MARGIN = 0.0001;

class APIClient {
	constructor() {
		this._init();
	}

	_init() {
		this.token = null;
		this.usernames = {};
		this.username = null;
		this.channels = [];
		this.ready = false;
		this.lastPoll = 0;
		this.handledMessages = {};
	}

	login(token) {
		this._init();

		if (token.length > 6) {
			this.token = token;
			return this.getUsernames();
		}
		return sendAPI('get_token', { pass: token })
		.then(res => {
			this.token = res.chat_token;
		})
		.then(() => this.getUsernames());
	}

	getUsernames() {
		return sendAPI('account_data', { chat_token: this.token })
		.then(res => {
			this.usernames = res.users;
			this.ready = true;
			return Object.keys(this.usernames);
		});
	}

	setUsername(username) {
		const channels = this.usernames[username];
		if (!channels) {
			return Promise.reject(new Error('You do not own that user'));
		}

		this.handledMessages = {};
		this.lastPoll = 0;
		this.username = username;
		this.channels = channels;

		return Promise.resolve(channels);
	}

	pollMessages() {
		if (!this.username || !this.ready) {
			return Promise.reject(new Error('Not logged in'));
		}

		return sendAPI('chats', { chat_token: this.token, usernames: [this.username] })
		.then(res => {
			return res.chats[this.username] || [];
		})
		.then(messages => {
			this.lastPoll = messages.reduce((i, ele) => {
				if (!i || ele.t > i) {
					i = ele.t;
				}
			}, this.lastPoll);
			return messages;
		})
		.filter(msg => {
			if (!this.handledMessages[msg.id]) {
				this.handledMessages[msg.id] = true;
				return true;
			}

			return false;
		})
		.then(messages => {
			return messages.sort((a,b) => {
				if (a.t > b.t) {
					return 1;
				} else if (a.t < b.t) {
					return -1;
				}
				return a.id.localeCompare(b.id);
			});
		});
	}

	sendChatToUser(username, msg) {
		return sendAPI('create_chat', { chat_token: this.token, username: this.username, tell: username, msg: msg });
	}

	sendChatToChannel(channel, msg) {
		return sendAPI('create_chat', { chat_token: this.token, username: this.username, channel: channel, msg: msg });
	}
}

module.exports = APIClient;