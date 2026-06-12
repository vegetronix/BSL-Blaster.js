const { SerialPort } = require('serialport');
const fs = require('fs');

var verbose;


function getArgs() {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.error('Usage: node nbsl.js <firmware.txt> [serial-port] [verbose]');
        console.error('Example: node nbsl.js firmware.txt');
        console.error('Example: node nbsl.js firmware.txt /dev/ttyUSB0');
        console.error('Example: node nbsl.js firmware.txt /dev/ttyUSB0 true');
        process.exit(1);
    }

    return {
        firmwareFile: args[0],
        serialPort: args[1] || '/dev/ttyUSB0',
        verbose: args[2]?.toLowerCase() === 'true'
    };
}

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

function u24le(value) {
    return Buffer.from([
        value & 0xFF,
        (value >> 8) & 0xFF,
        (value >> 16) & 0xFF
    ]);
}

function u16le(value) {
    return Buffer.from([
        value & 0xFF,
        (value >> 8) & 0xFF
    ]);
}

function makeLoadPcPayload(address) {
    return Buffer.concat([
        Buffer.from([0x17]),   // LOAD_PC
        u24le(address)         // 20-bit address
    ]);
}



function makeRxDataBlockPayload(address, data) {
    return Buffer.concat([
        Buffer.from([0x10]),   // RX_DATA_BLOCK
        u24le(address),        // 20-bit address
        data                   // NO length field here
    ]);
}

async function writeFirmwareBlocks(port, blocks) {
    for (const block of blocks) {

        // BSL packets have limited payload size.
        // Keep chunks conservative while debugging.
        const chunkSize = 256;

        for (let offset = 0; offset < block.data.length; offset += chunkSize) {
            const chunk = block.data.slice(offset, offset + chunkSize);
            const address = block.address + offset;
            const payload = makeRxDataBlockPayload(address, chunk);
            const pkt = makeBslPacket(payload);
            if (verbose) {
                console.log(
                    `Writing 0x${address.toString(16).padStart(4, '0')} length ${chunk.length}`
                );
            }
            const rx = await sendPacketAndWaitForFullResponse(port, pkt);
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

    if (verbose)
        console.log('TX:', hex(pkt));

    await new Promise((resolve, reject) => {
        port.write(pkt, err => {
            if (err) reject(err);
            else port.drain(resolve);
        });
    });

    await delay(responseDelayMs);

    port.off('data', onData);
    if (verbose)
        console.log('RX:', hex(rxBuf));

    return rxBuf;
}

async function sendPacketAndWaitForFullResponse(port, pkt, timeoutMs = 1000) {
    let rxBuf = Buffer.alloc(0);

    return await new Promise((resolve, reject) => {
        const start = Date.now();

        const cleanup = () => {
            clearInterval(timer);
            port.off('data', onData);
        };

        const tryComplete = () => {
            if (rxBuf.length < 1)
                return;

            // ACK error only, no packet follows
            if (rxBuf[0] !== 0x00) {
                cleanup();
                resolve(rxBuf);
                return;
            }

            // Need ACK + header + length
            if (rxBuf.length < 4)
                return;

            if (rxBuf[1] !== 0x80)
                return;

            const len = rxBuf[2] | (rxBuf[3] << 8);

            // ACK + header + len bytes + CRC16
            const expected = 1 + 3 + len + 2;

            if (rxBuf.length >= expected) {
                cleanup();
                resolve(rxBuf.slice(0, expected));
            }
        };

        const onData = data => {
            rxBuf = Buffer.concat([rxBuf, data]);
            tryComplete();
        };

        const timer = setInterval(() => {
            if (Date.now() - start > timeoutMs) {
                cleanup();
                reject(new Error(`Timeout waiting for response. RX: ${hex(rxBuf)}`));
            }
        }, 10);

        port.on('data', onData);

        port.write(pkt, err => {
            if (err) {
                cleanup();
                reject(err);
                return;
            }

            port.drain(err => {
                if (err) {
                    cleanup();
                    reject(err);
                }
            });
        });
    });
}

function wrongPasswordFailed(rxBuf) {
    checkAck(rxBuf);
    if (rxBuf.length < 8)
        throw new Error('Response too short');
    const status = rxBuf[5];
    if (status === 0x05) {
        console.log('MASS ERASE TRIGGERED - ');
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

function padChunk(chunk, size = 128) {
    if (chunk.length === size) return chunk;
    const pad = Buffer.alloc(
        size - chunk.length,
        0xFF
    );
    return Buffer.concat([chunk, pad]);
}

async function setLines(port, dtr, rts, invert = true) { // dtr-> SBWTDIO, rts -> SBWTCK
    if (invert) {
        dtr = !dtr;
        rts = !rts;
    }
    await new Promise((resolve, reject) => {
        port.set({ dtr, rts },
            err => {
                if (err)
                    reject(err);
                else
                    resolve();
            }
        );
    });
}

async function invokeBsl(port) {
    console.log('INVOKING BSL...');
    let ms = 1;
    // idle state
    await setLines(port, false, false); // dtr-> SBWTDIO, rts -> SBWTCK
    await delay(ms);

    for (let i = 0; i < 3; i++) { // 2 pulses where SBWTDIO is low, and 3 rising edges of SBWTCK
        // TEST high
        await setLines(port, false, true);
        await delay(ms);
        await setLines(port, false, false); // dtr-> SBWTDIO, rts -> SBWTCK
        await delay(ms);
    }
    await setLines(port, false, true);
    await delay(ms);
    await setLines(port, true, true);
    await delay(ms);
    await setLines(port, true, false);
    await delay(ms);
    console.log('BSL sequence complete');
}


function makeTxDataBlockPayload(address, length) {
    return Buffer.concat([
        Buffer.from([0x18]),   // TX_DATA_BLOCK
        u24le(address),        // 20-bit address, little-endian in 3 bytes
        u16le(length)
    ]);
}



function parseTxDataResponse(rxBuf) {
    checkAck(rxBuf);

    if (rxBuf[1] !== 0x80)
        throw new Error(`Bad response header: 0x${rxBuf[1].toString(16)}`);

    const packetLen = rxBuf[2] | (rxBuf[3] << 8);
    const payload = rxBuf.slice(4, 4 + packetLen);

    if (payload[0] !== 0x3A)
        throw new Error(`Unexpected response command: 0x${payload[0].toString(16)}`);

    return payload.slice(1); // data starts immediately after 0x3A
}

async function readMemoryBlock(port, address, length) {
    const payload = makeTxDataBlockPayload(address, length);
    const pkt = makeBslPacket(payload);

    const rx = await sendPacketAndWaitForFullResponse(port, pkt);
    if (verbose)
        console.log(hex(rx));
    return parseTxDataResponse(rx);
}

function formatTiTxtBlock(address, data) {
    let out = `@${address.toString(16).toUpperCase()}\n`;

    for (let i = 0; i < data.length; i += 16) {
        out += data
            .slice(i, i + 16)
            .toString('hex')
            .match(/../g)
            .map(x => x.toUpperCase())
            .join(' ') + '\n';
    }

    return out;
}

async function dumpMemoryToTiTxt(port, blocks, outFile) {
    let out = '';

    for (const block of blocks) {
        let address = block.address;
        let remaining = block.data.length;
        let blockData = Buffer.alloc(0);

        while (remaining > 0) {
            const len = Math.min(32, remaining);

            const data = await readMemoryBlock(port, address, len);

            blockData = Buffer.concat([blockData, data]);

            address += len;
            remaining -= len;
        }

        out += formatTiTxtBlock(block.address, blockData);
    }

    out += 'q\n';

    fs.writeFileSync(outFile, out);
    console.log(`Readback written to ${outFile}`);
}

async function main() {
    //'/home/metin/work/Vegetronix/VG-RELAY-4S-4R/VG-RELAY-4S-4R-css/VG-RELAY-4S-4R-Code/Debug/VG-RELAY-4S-4R-Code.txt'
    const { firmwareFile, serialPort, verbose } = getArgs();


    const blocks = readTiTxtFile(firmwareFile);

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
        // open port
        await new Promise((resolve, reject) => {
            port.open(err => {
                if (err) reject(err);
                else resolve();
            });
        });
        console.log('Port opened');
        //for (let i = 0; i < 10; i++) {
        await invokeBsl(port);
        await delay(5000);
        //}

        let passwordPacket = makeBslPacket(wrongPasswordPayload);
        resp = await sendPacketAndWaitForFullResponse(port, passwordPacket);
        wrongPasswordFailed(resp);
        await delay(2000); // wait for mass erase to complete. 

        passwordPacket = makeBslPacket(passwordPayload);
        resp = await sendPacketAndWaitForFullResponse(port, passwordPacket);
        checkBslMessage(resp);

        console.log("CHANGING BAUD RATE TO: 115200");
        const changeBaudPayload = Buffer.from([0x52, 0x06]);
        const changeBaudPacket = makeBslPacket(changeBaudPayload);
        resp = await sendPacket(port, changeBaudPacket);
        // for baud there is no response other than an ack of 00.
        await delay(100);

        await new Promise((resolve, reject) => {
            port.update({ baudRate: 115200 }, err => {
                if (err) reject(err);
                else resolve();
            });
        });
        console.log("START WRITING");
        await writeFirmwareBlocks(port, blocks);
        // now read back
        console.log("DONE WRITING");
        console.log("START READING");
        await dumpMemoryToTiTxt(port, blocks, 'readback.txt');
        console.log("DONE READING");
        const loadPcPacket = makeBslPacket(makeLoadPcPayload(0x92F4));
        const rx = await sendPacket(port, loadPcPacket);
        // LOAD_PC does not return normally because execution jumps away. So don't require a normal BSL response here.
        console.log('EXECUTING PROGRAM...');
        console.log("DONE");
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

