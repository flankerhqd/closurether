﻿'use strict';

var fs = require('fs'),
	server = require("dgram").createSocket("udp4"),
	Socket = require('net').Socket;

var FLAG_RES = 0x8000,
	PUB_DNS = '8.8.8.8';

var queueMap = {};

var domain_type = {},
	TYPE_PENDING = 0,
	TYPE_WEB = 1,
	TYPE_APP = 2;


var qid_addr = [],
	ipBuf,
	bufAns = new Buffer([			//+16 bytes
		0xC0, 0x0C,					// domain ptr
		0x00, 0x01,					// type
		0x00, 0x01,					// class
		0x00, 0x00, 0x00, 0x0A,		// ttl
		0x00, 0x04,					// len
		0x00, 0x00, 0x00, 0x00,		// ip
	]);


function buildReply(bufReq, ipBuf) {
	//
	// DNS回复包和请求包 前面部分相同，
	// 所以可在请求包的基础上扩充。
	//
	var reply = new Buffer(bufReq.length + 16);
	bufReq.copy(reply);					// 前面部分（和请求的一样）

	ipBuf.copy(bufAns, +12);			// 填充我们的IP地址
	bufAns.copy(reply, bufReq.length);	// 后面部分（bufAns数据）

	reply.writeUInt16BE(0x8180, +2);	// [02~03] flags
	reply.writeUInt16BE(0x0001, +6);	// [06~07] answer-couter
	return reply;
}



server.on("message", function(msg, remoteEndPoint) {
	var reqId = msg.readUInt16BE(+0);
	var reqFlag = msg.readUInt16BE(+2);
	var s;

	//
	// 外网DNS服务器的答复，转给用户
	//
	if (reqFlag & FLAG_RES) {
		var ep = qid_addr[reqId];
		if (ep) {
			server.send(msg,
				0, msg.length,
				ep.port,
				ep.address
			);
			delete qid_addr[reqId];
		}
		return;
	}

	function sendPub() {
		// 发给外网DNS
		qid_addr[reqId] = remoteEndPoint;
		server.send(msg,
			0, msg.length,
			53,
			PUB_DNS
		);
	}

	function onConnOk() {
		// 回复用户查询
		var packet = buildReply(msg, ipBuf);
		server.send(packet,
			0, packet.length,
			remoteEndPoint.port,
			remoteEndPoint.address
		);
	}

	function onConnFail() {
		// 域名80端口连接失败
		s.destroy();

		domain_type[domain] = TYPE_APP;
		delete queueMap[domain];

		sendPub();
		console.warn('[DNS] %s is not a webdomain', domain);
	}


	// 获取域名字符串
	var key = msg.toString('utf8', +12, msg.length - 5);
	var domain = key.replace(/[\u0000-\u0020]/g, '.').substr(1);

	switch(domain_type[domain]) {
	case TYPE_PENDING:      //** 该域名在在解析中
		queueMap[domain].push(onConnOk);
		break;
	case TYPE_WEB:          //** 已知的Web域名
		onConnOk();
		break;
	case TYPE_APP:          //** 已知的App域名
		sendPub();
		break;
	case undefined:         //** 未知类型的域名
		domain_type[domain] = TYPE_PENDING;
		queueMap[domain] = [onConnOk];

		//
		// 尝试连接该域名的80端口
		//
		s = new Socket();
		s.on('connect', function() {
			s.destroy();
			domain_type[domain] = TYPE_WEB;

			// 该域名80端口可以连接，通知所有等待此域名的用户
			var i, queue = queueMap[domain];
			for(i = 0; i < queue.length; i++) {
				queue[i]();
			}
			delete queueMap[domain];
		});
		s.setTimeout(2000, onConnFail);
		s.on('error', onConnFail);
		s.connect(80, domain);
		break;
	}

	console.log('[DNS] %s\tQuery %s', remoteEndPoint.address, domain);
})


server.on("listening", function() {
	console.log("[DNS] running %s:%d",
		server.address().address,
		server.address().port
	);
});

server.on("error", function() {
	console.error('[DNS] fail listen UDP:53');
});



exports.start = function() {
	server.bind(53);
}

exports.stop = function() {
	server.close();
}

exports.setPubDNS = function(ip) {
	PUB_DNS = ip;
}

exports.setLocalIP = function(ip) {
	ipBuf = new Buffer(ip.split('.'));
}
