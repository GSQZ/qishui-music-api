const { createQishuiApi, QISHUI_OPERATIONS } = require('./src/api.cjs');
const { createQishuiDeviceId, isQishuiDeviceId, isAccountId } = require('./src/protocol.cjs');

// Host-neutral entry point; all persistence and HTTP transport can be supplied by the caller.
module.exports = { createQishuiApi, QISHUI_OPERATIONS, createQishuiDeviceId, isQishuiDeviceId, isAccountId };
