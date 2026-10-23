const CHANNEL = 'aipi.ide.v1';

function requestEnvelope(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.channel === CHANNEL && message.type === 'request' && typeof message.id === 'string' && typeof message.action === 'string') {
    return {id:message.id, action:message.action, payload:message.payload ?? {}};
  }
  if (message.type === 'aipi:request' && typeof message.id === 'string') {
    const {id, action, type, ...payload} = message;
    return {id, action, payload};
  }
  return null;
}

const response = (id, result) => ({channel:CHANNEL, type:'response', id, ok:true, result});
const failure = (id, error) => ({channel:CHANNEL, type:'response', id, ok:false, error:{message:error.message, code:error.code, status:error.status}});
const event = (name, payload = {}) => ({channel:CHANNEL, type:'event', event:name, payload});
const stream = (streamId, phase, payload = {}) => ({channel:CHANNEL, type:'stream', streamId, phase, payload});

module.exports = {CHANNEL, requestEnvelope, response, failure, event, stream};
