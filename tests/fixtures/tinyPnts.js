'use strict';

function paddedJsonBuffer(value) {
    const json = JSON.stringify(value);
    const padding = (8 - (Buffer.byteLength(json) % 8)) % 8;
    return Buffer.from(json + ' '.repeat(padding), 'utf8');
}

function arrayBufferFromBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function buildTinyPnts(options = {}) {
    const positions = options.positions || [
        [0, 0, 0],
        [0, 12, 0]
    ];
    const rtcCenter = options.rtcCenter || [0, 0, 0];

    const featureTableJson = paddedJsonBuffer({
        POINTS_LENGTH: positions.length,
        POSITION: { byteOffset: 0 },
        RTC_CENTER: rtcCenter
    });

    const featureTableBinary = Buffer.alloc(positions.length * 3 * 4);
    positions.flat().forEach((value, index) => {
        featureTableBinary.writeFloatLE(value, index * 4);
    });

    const batchTableJson = Buffer.alloc(0);
    const batchTableBinary = Buffer.alloc(0);
    const byteLength = 28 +
        featureTableJson.length +
        featureTableBinary.length +
        batchTableJson.length +
        batchTableBinary.length;

    const header = Buffer.alloc(28);
    header.write('pnts', 0, 'ascii');
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(byteLength, 8);
    header.writeUInt32LE(featureTableJson.length, 12);
    header.writeUInt32LE(featureTableBinary.length, 16);
    header.writeUInt32LE(batchTableJson.length, 20);
    header.writeUInt32LE(batchTableBinary.length, 24);

    return arrayBufferFromBuffer(Buffer.concat([
        header,
        featureTableJson,
        featureTableBinary,
        batchTableJson,
        batchTableBinary
    ], byteLength));
}

module.exports = {
    buildTinyPnts
};
