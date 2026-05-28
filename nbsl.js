const { SerialPort } = require('serialport');
const fs = require('fs');

const ACK_ERRORS = {
    0x51: 'Header incorrect',
    0x52: 'Checksum incorrect',
    0x53: 'Packet size zero',
    0x54: 'Packet size exceeds buffer',
    0x55: 'Unknown error',
    0x56: 'Unknown baud rate',
    0x57: 'Packet size error'
};

function checkAck(rxBuf) {
    if (rxBuf.length === 0) {
        throw new Error('No response from device');
    }
    const ack = rxBuf[0];
    if (ack === 0x00) {
        return;
    }
    const msg =
        ACK_ERRORS[ack] ??
        `Unknown ACK code 0x${ack.toString(16)}`;
    throw new Error(
        `BSL ACK error: ${msg}`
    );
}

function readTiTxtFile(filename) {
    const text = fs.readFileSync(filename, 'utf8');

    const blocks = [];
    let currentAddress = null;
    let currentData = [];

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith('//')) continue;

        if (line === 'q') break;

        if (line.startsWith('@')) {
            if (currentAddress !== null && currentData.length > 0) {
                blocks.push({
                    address: currentAddress,
                    data: Buffer.from(currentData)
                });
            }

            currentAddress = parseInt(line.slice(1), 16);
            currentData = [];
            continue;
        }

        const bytes = line.split(/\s+/).map(x => parseInt(x, 16));

        for (const b of bytes) {
            if (Number.isNaN(b) || b < 0 || b > 0xFF) {
                throw new Error(`Bad byte in TI-TXT file: ${line}`);
            }

            currentData.push(b);
        }
    }

    if (currentAddress !== null && currentData.length > 0) {
        blocks.push({
            address: currentAddress,
            data: Buffer.from(currentData)
        });
    }

    return blocks;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// MSP430 BSL checksum
function bslCrc(payload) {
    let crc = 0xFFFF;
    for (const b of payload) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x8000)
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            else
                crc = (crc << 1) & 0xFFFF;
        }
    }
    return Buffer.from([
        crc & 0xFF,        // CKL
        (crc >> 8) & 0xFF  // CKH
    ]);
}

function makeBslPacket(payload) {
    const length = payload.length;
    const header = Buffer.from([
        0x80,
        length & 0xFF,
        (length >> 8) & 0xFF
    ]);
    return Buffer.concat([
        header,
        payload,
        bslCrc(payload)
    ]);
}

function hex(buf) {
    return buf.toString('hex').match(/../g)?.join(' ') ?? '';
}

function u16le(value) {
    return Buffer.from([
        value & 0xFF,
        (value >> 8) & 0xFF
    ]);
}

function makeRxDataBlockPayload(address, data) {
    return Buffer.concat([
        Buffer.from([0x10]),   // RX_DATA_BLOCK
        u16le(address),        // address
        u16le(data.length),    // number of bytes
        data
    ]);
}

async function writeFirmwareBlocks(port, blocks) {
    for (const block of blocks) {

        // BSL packets have limited payload size.
        // Keep chunks conservative while debugging.
        const chunkSize = 32; // snick was 128

        for (let offset = 0; offset < block.data.length; offset += chunkSize) {
            const chunk = block.data.slice(offset, offset + chunkSize);
            const address = block.address + offset;

            const payload = makeRxDataBlockPayload(address, chunk);
            const pkt = makeBslPacket(payload);

            console.log(
                `Writing 0x${address.toString(16).padStart(4, '0')} length ${chunk.length}`
            );

            const rx = await sendPacket(port, pkt, 200);
            checkBslMessage(rx);
        }
    }
}

const BSL_STATUS = {
    0x00: 'Operation successful',
    0x01: 'Memory write check failed',
    0x04: 'BSL locked',
    0x05: 'BSL password error',
    0x07: 'Unknown command'
};

function checkBslMessage(rxBuf) {
    checkAck(rxBuf);

    if (rxBuf.length < 8)
        throw new Error('Response too short');

    if (rxBuf[1] !== 0x80)
        throw new Error(`Bad BSL response header: 0x${rxBuf[1].toString(16)}`);

    const len = rxBuf[2] | (rxBuf[3] << 8);
    const cmd = rxBuf[4];
    const status = rxBuf[5];

    if (cmd !== 0x3B)
        throw new Error(`Unexpected BSL response command: 0x${cmd.toString(16)}`);

    if (status !== 0x00) {
        throw new Error(
            `BSL command failed: ${BSL_STATUS[status] ?? 'Unknown status'} ` +
            `(0x${status.toString(16).padStart(2, '0')})`
        );
    }
}

async function sendPacket(port, pkt, responseDelayMs = 200) {
    let rxBuf = Buffer.alloc(0);

    const onData = data => {
        rxBuf = Buffer.concat([rxBuf, data]);
    };

    port.on('data', onData);

    console.log('TX:', hex(pkt));

    await new Promise((resolve, reject) => {
        port.write(pkt, err => {
            if (err) reject(err);
            else port.drain(resolve);
        });
    });

    await delay(responseDelayMs);

    port.off('data', onData);

    console.log('RX:', hex(rxBuf));

    return rxBuf;
}

function wrongPasswordFailed(rxBuf) {
    checkAck(rxBuf);
    if (rxBuf.length < 8)
        throw new Error('Response too short');
    const status = rxBuf[5];
    if (status === 0x05) {
        console.log('Expected password failure / mass erase trigger');
        return;
    }
    if (status !== 0x00) {
        throw new Error(
            `BSL command failed (0x${status.toString(16).padStart(2, '0')})`
        );
    }
}

async function closePort(port) {
    if (!port.isOpen)
        return;
    await new Promise((resolve, reject) => {
        port.close(err => {

            if (err)
                reject(err);
            else
                resolve();
        });
    });
}

async function main() {
    const blocks = readTiTxtFile('/home/metin/work/Vegetronix/VG-RELAY-4S-4R/VG-RELAY-4S-4R-css/VG-RELAY-4S-4R-Code/Debug/VG-RELAY-4S-4R-Code.txt');

    for (const block of blocks) {
        console.log(
            `Address: 0x${block.address.toString(16)}, bytes: ${block.data.length}`
        );
    }

    const port = new SerialPort({
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        dataBits: 8,
        parity: 'even',
        stopBits: 1,
        autoOpen: false
    });


    // open port
    await new Promise((resolve, reject) => {
        port.open(err => {
            if (err) reject(err);
            else resolve();
        });
    });
    console.log('Port opened');

    // delay after opening
    await delay(500);

    const passwordPayload = Buffer.from([
        0x11,                 // RX_PASSWORD command
        ...Array(32).fill(0xFF)
    ]);

    const wrongPasswordPayload = Buffer.from([
        0x11,                 // RX_PASSWORD command
        ...Array(32).fill(0x00)
    ]);

    try {
        let resp;
        /*        const changeBaudPayload = Buffer.from([0x52, 0x06]);
                const changeBaudPacket = makeBslPacket(changeBaudPayload);
                resp = await sendPacket(port, changeBaudPacket);
                //checkAck(resp); // doesn't send a packet just an Ack
                await closePort(port);
                await delay(500);
                await new Promise((resolve, reject) => {
                    port.update({ baudRate: 115200 }, err => {
                        if (err) reject(err);
                        else resolve();
                    });
                }); */

        let passwordPacket = makeBslPacket(wrongPasswordPayload);
        resp = await sendPacket(port, passwordPacket);
        wrongPasswordFailed(resp);
        await delay(3000);

        passwordPacket = makeBslPacket(passwordPayload);
        resp = await sendPacket(port, passwordPacket);
        checkBslMessage(resp);

        await writeFirmwareBlocks(port, blocks);




    } catch (er) {
        console.log(er);
    }


    // optional delay before closing
    await delay(1000);

    port.close();
}

main().catch(err => {
    console.error(err);
});