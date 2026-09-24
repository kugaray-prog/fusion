/**
 * Generates loadtest/cases/geoattend-test-cases.jmx: one JMeter thread group
 * (or two) per test case LT-01..LT-10. Pick the case at run time with
 * -JCASE=LT-01; every other case's thread groups get 0 threads.
 *
 *   node loadtest/cases/build-plan.js
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (name, v) => `<stringProp name="${name}">${esc(v)}</stringProp>`;
const bool = (name, v) => `<boolProp name="${name}">${v}</boolProp>`;
const tree = (el, children = []) => `${el}\n<hashTree>\n${children.join('\n')}\n</hashTree>`;

const onlyFor = (c, n) => `\${__jexl3('\${__P(CASE,)}' == '${c}' ? ${n} : 0)}`;

function threadGroup({ name, caseId, threads, ramp = 0, loops = 1, delay = 0, children }) {
  return tree(
    `<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="${esc(name)}">
${str('ThreadGroup.on_sample_error', 'continue')}
<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">
${bool('LoopController.continue_forever', false)}
${str('LoopController.loops', loops)}
</elementProp>
${str('ThreadGroup.num_threads', onlyFor(caseId, threads))}
${str('ThreadGroup.ramp_time', ramp)}
${bool('ThreadGroup.scheduler', true)}
${str('ThreadGroup.duration', '${__P(MAX_DURATION,1800)}')}
${str('ThreadGroup.delay', delay)}
${bool('ThreadGroup.same_user_on_next_iteration', true)}
</ThreadGroup>`,
    children
  );
}

function csv(file) {
  return tree(`<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="${esc(file)}">
${str('filename', `\${__P(DATA_DIR)}/${file}`)}
${str('fileEncoding', 'UTF-8')}
${str('variableNames', '')}
${bool('ignoreFirstLine', false)}
${str('delimiter', ',')}
${bool('quotedData', false)}
${bool('recycle', false)}
${bool('stopThread', true)}
${str('shareMode', 'shareMode.group')}
</CSVDataSet>`);
}

function headers(pairs, name = 'Headers') {
  return tree(`<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="${esc(name)}">
<collectionProp name="HeaderManager.headers">
${pairs.map(([k, v]) => `<elementProp name="" elementType="Header">${str('Header.name', k)}${str('Header.value', v)}</elementProp>`).join('\n')}
</collectionProp>
</HeaderManager>`);
}

// ignoreStatus: let this assertion decide pass/fail even for HTTP 4xx (JMeter
// otherwise fails any 4xx before the assertion runs), e.g. an expected 409.
function assertCode(pattern, name = `Status ${pattern}`, ignoreStatus = false) {
  return tree(`<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${esc(name)}">
<collectionProp name="Asserion.test_strings">${str('p', pattern)}</collectionProp>
${str('Assertion.custom_message', '')}
${str('Assertion.test_field', 'Assertion.response_code')}
${bool('Assertion.assume_success', ignoreStatus)}
<intProp name="Assertion.test_type">1</intProp>
</ResponseAssertion>`);
}

function assertBody(substring, name) {
  return tree(`<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${esc(name)}">
<collectionProp name="Asserion.test_strings">${str('p', substring)}</collectionProp>
${str('Assertion.custom_message', '')}
${str('Assertion.test_field', 'Assertion.response_data')}
${bool('Assertion.assume_success', false)}
<intProp name="Assertion.test_type">16</intProp>
</ResponseAssertion>`);
}

function syncTimer(groupSize) {
  return tree(`<SyncTimer guiclass="TestBeanGUI" testclass="SyncTimer" testname="Release together">
${str('groupSize', groupSize)}
<longProp name="timeoutInMs">30000</longProp>
</SyncTimer>`);
}

function constantTimer(ms) {
  return tree(`<ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="Wait ${ms} ms">${str('ConstantTimer.delay', ms)}</ConstantTimer>`);
}

function loop(name, count, children) {
  return tree(`<LoopController guiclass="LoopControlPanel" testclass="LoopController" testname="${esc(name)}">
${bool('LoopController.continue_forever', true)}
${str('LoopController.loops', count)}
</LoopController>`, children);
}

function jsonRequest(name, method, urlPath, body, children = []) {
  return tree(`<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${esc(name)}">
${bool('HTTPSampler.postBodyRaw', body != null)}
<elementProp name="HTTPsampler.Arguments" elementType="Arguments">
<collectionProp name="Arguments.arguments">
${body != null ? `<elementProp name="" elementType="HTTPArgument">${bool('HTTPArgument.always_encode', false)}${str('Argument.value', body)}${str('Argument.metadata', '=')}</elementProp>` : ''}
</collectionProp>
</elementProp>
${str('HTTPSampler.path', urlPath)}
${str('HTTPSampler.method', method)}
${bool('HTTPSampler.use_keepalive', true)}
</HTTPSamplerProxy>`, [...(body != null ? [headers([['Content-Type', 'application/json']], 'JSON')] : []), ...children]);
}

function multipartRequest(name, urlPath, fields, file, children = []) {
  return tree(`<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${esc(name)}">
<elementProp name="HTTPsampler.Arguments" elementType="Arguments">
<collectionProp name="Arguments.arguments">
${fields.map(([k, v]) => `<elementProp name="${esc(k)}" elementType="HTTPArgument">${bool('HTTPArgument.always_encode', false)}${str('Argument.name', k)}${str('Argument.value', v)}${bool('HTTPArgument.use_equals', true)}${str('Argument.metadata', '=')}</elementProp>`).join('\n')}
</collectionProp>
</elementProp>
<elementProp name="HTTPsampler.Files" elementType="HTTPFileArgs">
<collectionProp name="HTTPFileArgs.files">
<elementProp name="${esc(file.path)}" elementType="HTTPFileArg">${str('File.path', file.path)}${str('File.paramname', file.param)}${str('File.mimetype', 'image/jpeg')}</elementProp>
</collectionProp>
</elementProp>
${str('HTTPSampler.path', urlPath)}
${str('HTTPSampler.method', 'POST')}
${bool('HTTPSampler.DO_MULTIPART_POST', true)}
${bool('HTTPSampler.use_keepalive', true)}
</HTTPSamplerProxy>`, children);
}

// ---------------------------------------------------------------------------

const employeeHeaders = headers([['Authorization', 'Bearer ${token}'], ['CF-Connecting-IP', '${ip}']], 'Employee phone');
const adminHeaders = (ipPrefix) => headers([['Authorization', 'Bearer ${__P(ADMIN_TOKEN)}'], ['CF-Connecting-IP', `${ipPrefix}.\${__threadNum}`]], 'Admin browser');
const submitBody = '{"employee_id":${employee_id},"device_uid":"${device_uid}","event_id":${event_id},"latitude":${lat},"longitude":${lng},"accuracy":12}';
const submit = (extra = []) => jsonRequest('POST /api/attendance/submit', 'POST', '/api/attendance/submit', submitBody, [assertCode('201', 'Recorded (201)'), ...extra]);

const attendanceCase = (caseId, name, threads, ramp, file) =>
  threadGroup({ name: `${caseId} ${name}`, caseId, threads, ramp, children: [csv(file), employeeHeaders, submit()] });

const reportRequests = [
  ['GET /api/reports (this year)', '/api/reports?year=${__time(yyyy)}'],
  ['GET /api/reports (by department)', '/api/reports?department=College%20of%20Computer%20Studies'],
  ['GET /api/reports/insights', '/api/reports/insights'],
  ['GET /api/reports/export/csv', '/api/reports/export/csv'],
  ['GET /api/reports/export/excel', '/api/reports/export/excel']
];

const heartbeatBody = (lat, lng) => `{"latitude":\${${lat}},"longitude":\${${lng}}}`;
const heartbeat = (name, lat, lng, extra = []) =>
  jsonRequest(name, 'POST', '/api/attendance/${attendance_id}/heartbeat', heartbeatBody(lat, lng), [constantTimer(21000), assertCode('200', 'OK (200)'), ...extra]);

const regFields = [
  ['pendingToken', '${pending_token}'], ['employee_code', '${employee_code}'], ['surname', '${surname}'], ['given_name', '${given_name}'],
  ['department', 'College of Computer Studies'], ['position', 'Instructor I'], ['gender', 'Female'], ['classification', 'Permanent Academic'],
  ['device_uid', '${device_uid}'], ['device_model', 'LoadTest Phone'], ['device_brand', 'JMeter'], ['device_os', 'Android 14'],
  ['liveness_verified', 'true'], ['liveness_actions', 'hold_still,blink']
];

const groups = [
  attendanceCase('LT-01', '50 employees submit within 1 minute', 50, 60, 'LT-01.csv'),
  attendanceCase('LT-02', '150 employees submit within 1 minute', 150, 60, 'LT-02.csv'),

  threadGroup({
    name: 'LT-03 5 HRMDU admins generate reports at once', caseId: 'LT-03', threads: 5, loops: 3, delay: 20,
    children: [adminHeaders('10.99.3'), ...reportRequests.map(([n, p], i) => jsonRequest(n, 'GET', p, null, [...(i === 0 ? [syncTimer(5)] : []), assertCode('200', 'OK (200)')]))]
  }),
  threadGroup({
    name: 'LT-03 Responsiveness probe (health + dashboard)', caseId: 'LT-03', threads: 1, loops: 70,
    children: [adminHeaders('10.99.4'),
      jsonRequest('PROBE GET /api/health', 'GET', '/api/health', null, [constantTimer(500), assertCode('200', 'OK (200)')]),
      jsonRequest('PROBE GET /api/dashboard/stats', 'GET', '/api/dashboard/stats', null, [constantTimer(500), assertCode('200', 'OK (200)')])]
  }),

  // 1,500 arrivals over 600 s = 2.5 submissions/s, LT-02's peak rate, held for 10 minutes.
  attendanceCase('LT-04', 'Peak submission rate held for 10 minutes', 1500, 600, 'LT-04.csv'),

  threadGroup({ name: 'LT-05 Baseline 10 submissions', caseId: 'LT-05', threads: 10, ramp: 10, children: [csv('LT-05-baseline.csv'), employeeHeaders, submit()] }),
  threadGroup({ name: 'LT-05 Spike to 200 concurrent submissions', caseId: 'LT-05', threads: 200, ramp: 0, delay: 15, children: [csv('LT-05-spike.csv'), employeeHeaders, submit([syncTimer(200)])] }),

  attendanceCase('LT-06', '291 employees submit within 5 minutes', 291, 300, 'LT-06.csv'),

  threadGroup({
    name: 'LT-07 50 new employees register device + face at once', caseId: 'LT-07', threads: 50, ramp: 0,
    children: [csv('LT-07.csv'), headers([['CF-Connecting-IP', '${ip}']], 'Phone IP'),
      multipartRequest('POST /api/employee-auth/link-device', '/api/employee-auth/link-device', regFields, { path: '${__P(REG_IMAGE)}', param: 'image' },
        [syncTimer(50), assertCode('201', 'Registered (201)')])]
  }),

  // Each open session pings from inside the geofence 10 times (21 s apart,
  // just over the 20 s debounce), then twice from outside. The 2nd outside
  // ping must auto-close the session; one more ping must find it closed.
  threadGroup({
    name: 'LT-08 100 active sessions send heartbeats, then leave', caseId: 'LT-08', threads: 100, ramp: 20,
    children: [csv('LT-08.csv'), employeeHeaders,
      loop('10 pings inside the geofence', 10, [heartbeat('POST heartbeat (inside)', 'lat', 'lng', [assertBody('"ended":false', 'Session still open')])]),
      heartbeat('POST heartbeat (outside #1)', 'out_lat', 'out_lng', [assertBody('"ended":false', 'Not closed after 1 outside ping')]),
      heartbeat('POST heartbeat (outside #2)', 'out_lat', 'out_lng', [assertBody('"ended":true', 'Auto-closed after 2 outside pings')]),
      heartbeat('POST heartbeat (after close)', 'out_lat', 'out_lng', [assertBody('"ended":true', 'Stays closed')])]
  }),

  threadGroup({
    name: 'LT-09 Kiosk face verification, 10 concurrent', caseId: 'LT-09', threads: 10, ramp: 0, loops: 5,
    children: [adminHeaders('10.99.9'),
      multipartRequest('POST /api/face/verify', '/api/face/verify',
        [['liveness_verified', 'true'], ['liveness_actions', 'hold_still,blink'], ['event_id', '${__P(KIOSK_EVENT_ID)}']],
        { path: '${__P(KIOSK_IMAGE)}', param: 'image' },
        [syncTimer(10), assertCode('200', 'OK (200)'), assertBody('"result":"matched"', 'Face matched')])]
  }),

  // Slow links come from -Jhttpclient.socket.http.cps (bytes/s, whole run).
  // Group B re-sends the same 30 submissions 1 s later, while group A's are
  // still in flight: a phone retrying or a double-tap. Exactly one of each
  // pair may succeed (201); the other must be refused (409).
  threadGroup({ name: 'LT-10 30 users on slow connections', caseId: 'LT-10', threads: 30, ramp: 0, children: [csv('LT-10.csv'), employeeHeaders, jsonRequest('POST /api/attendance/submit (first try)', 'POST', '/api/attendance/submit', submitBody, [syncTimer(30), assertCode('201|409', '201 or 409', true)])] }),
  threadGroup({ name: 'LT-10 Same 30 users retry 1 s later', caseId: 'LT-10', threads: 30, ramp: 0, delay: 1, children: [csv('LT-10.csv'), employeeHeaders, jsonRequest('POST /api/attendance/submit (retry)', 'POST', '/api/attendance/submit', submitBody, [syncTimer(30), assertCode('201|409', '201 or 409', true)])] })
];

const plan = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by loadtest/cases/build-plan.js - edit that script, not this file. See loadtest/cases/README.md. -->
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
<hashTree>
${tree(`<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="GeoAttend Pro load-test cases LT-01..LT-10">
${bool('TestPlan.functional_mode', false)}
${bool('TestPlan.serialize_threadgroups', false)}
<elementProp name="TestPlan.user_defined_variables" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>
</TestPlan>`, [
  tree(`<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults">
<elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>
${str('HTTPSampler.domain', '${__P(HOST,localhost)}')}
${str('HTTPSampler.port', '${__P(PORT,3200)}')}
${str('HTTPSampler.protocol', '${__P(PROTOCOL,http)}')}
${str('HTTPSampler.contentEncoding', 'UTF-8')}
${str('HTTPSampler.implementation', 'HttpClient4')}
${str('HTTPSampler.connect_timeout', '10000')}
${str('HTTPSampler.response_timeout', '120000')}
</ConfigTestElement>`),
  ...groups
])}
</hashTree>
</jmeterTestPlan>
`;

const out = path.join(__dirname, 'geoattend-test-cases.jmx');
fs.writeFileSync(out, plan);
console.log('Wrote', out);
