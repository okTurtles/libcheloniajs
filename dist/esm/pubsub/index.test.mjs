import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient } from './index.mjs';
const client = createClient('ws://localhost:8080', {
    manual: true,
    reconnectOnDisconnection: false,
    reconnectOnOnline: false,
    reconnectOnTimeout: false
});
const { maxReconnectionDelay, minReconnectionDelay } = client.options;
const createRandomDelays = (number) => {
    return [...new Array(number)].map((_, i) => {
        client.failedConnectionAttempts = i;
        return client.getNextRandomDelay();
    });
};
const delays1 = createRandomDelays(10);
const delays2 = createRandomDelays(10);
describe('Test getNextRandomDelay()', function () {
    it('every delay should be longer than the previous one', function () {
        // In other words, the delays should be sorted in ascending numerical order.
        assert.deepEqual(delays1, [...delays1].sort((a, b) => a - b));
        assert.deepEqual(delays2, [...delays2].sort((a, b) => a - b));
    });
    it('no delay should be shorter than the minimal reconnection delay', function () {
        delays1.forEach((delay) => {
            assert.ok(delay >= minReconnectionDelay);
        });
        delays2.forEach((delay) => {
            assert.ok(delay >= minReconnectionDelay);
        });
    });
    it('no delay should be longer than the maximal reconnection delay', function () {
        delays1.forEach((delay) => {
            assert.ok(delay <= maxReconnectionDelay);
        });
        delays2.forEach((delay) => {
            assert.ok(delay <= maxReconnectionDelay);
        });
    });
});
