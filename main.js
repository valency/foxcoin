'use strict';

let CryptoJS = require("crypto-js");
let Express = require("express");
let BodyParser = require('body-parser');
let WebSocket = require("ws");

// Configurations

let MESSAGE_TYPE = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

let COMMENT_TYPE = {
    GENESIS: {
        id: 0,
        args: []
    }
};

let GENESIS_BLOCK = () => {
    let index = 0;
    let prev_hash = null;
    let timestamp = 1451606400;
    let data = [{
        source: null,
        target: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCKVKf8Nf/y78G/BglXHutS/kRdzryPbpg9hRgmBh+hNyFjispFyN1vlM0BLlQyMA64TACN//7nO0JcrDsEJbpHRf1DdepzBv1zx4FFaE62Wvj2AYv26FfX8mTfCat2lj4wkOsDbN94izcJaT8XC5hZh9d3RZ34bhqSTcY3Fc4D0wIDAQAB",
        timestamp: 1451606100,
        amount: 10000000.0,
        source_balance: 0.0,
        target_balance: 10000000.0,
        comment: [COMMENT_TYPE.GENESIS.id]
    }];
    let hash = calculate_hash(index, prev_hash, timestamp, data);
    return new Block(index, prev_hash, timestamp, data, hash);
};

class Block {
    constructor(index, prev_hash, timestamp, data, hash) {
        this.index = index;
        this.prev_hash = prev_hash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
    }
}

// Inputs

let HTTP_PORT = process.env.HTTP_PORT || 8111;
let P2P_PORT = process.env.P2P_PORT || 18111;
let INITIAL_PEERS = process.env.PEERS ? process.env.PEERS.split(',') : [];

// Global Variables

let SOCKETS = [];
let BLOCKCHAIN = [GENESIS_BLOCK()];

// Methods

let initHttpServer = () => {
    let app = Express();
    app.use(BodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(BLOCKCHAIN)));
    app.post('/mineBlock', (req, res) => {
        let newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(SOCKETS.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(HTTP_PORT, () => console.log('Listening http on port: ' + HTTP_PORT));
};


let initP2PServer = () => {
    let server = new WebSocket.Server({port: P2P_PORT});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + P2P_PORT);

};

let initConnection = (ws) => {
    SOCKETS.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

let initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        let message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MESSAGE_TYPE.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MESSAGE_TYPE.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MESSAGE_TYPE.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

let initErrorHandler = (ws) => {
    let closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        SOCKETS.splice(SOCKETS.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


let generateNextBlock = (blockData) => {
    let previousBlock = getLatestBlock();
    let nextIndex = previousBlock.index + 1;
    let nextTimestamp = new Date().getTime() / 1000;
    let nextHash = calculate_hash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
};


let calculate_hashForBlock = (block) => {
    return calculate_hash(block.index, block.prev_hash, block.timestamp, block.data);
};

let calculate_hash = (index, prev_hash, timestamp, data) => {
    return CryptoJS.SHA256(index + prev_hash + timestamp + JSON.stringify(data)).toString();
};

let addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        BLOCKCHAIN.push(newBlock);
    }
};

let isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.prev_hash) {
        console.log('invalid prev_hash');
        return false;
    } else if (calculate_hashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculate_hashForBlock(newBlock));
        console.log('invalid hash: ' + calculate_hashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

let connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        let ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

let handleBlockchainResponse = (message) => {
    let receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index > b2.index));
    let latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    let latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.prev_hash) {
            console.log("We can append the received block to our chain");
            BLOCKCHAIN.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};

let replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > BLOCKCHAIN.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        BLOCKCHAIN = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

let isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(get_genesis_block())) {
        return false;
    }
    let tempBlocks = [blockchainToValidate[0]];
    for (let i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

let getLatestBlock = () => BLOCKCHAIN[BLOCKCHAIN.length - 1];
let queryChainLengthMsg = () => ({'type': MESSAGE_TYPE.QUERY_LATEST});
let queryAllMsg = () => ({'type': MESSAGE_TYPE.QUERY_ALL});
let responseChainMsg = () => ({
    'type': MESSAGE_TYPE.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(BLOCKCHAIN)
});
let responseLatestMsg = () => ({
    'type': MESSAGE_TYPE.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

let write = (ws, message) => ws.send(JSON.stringify(message));
let broadcast = (message) => SOCKETS.forEach(socket => write(socket, message));

connectToPeers(INITIAL_PEERS);
initHttpServer();
initP2PServer();