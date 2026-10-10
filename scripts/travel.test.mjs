import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { readLoggedEvents } from './file-test-helpers.mjs'
import { setTestEnvironment, withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import {
  ambiguousExitCode,
  credentialsExitCode,
  nothingFoundExitCode,
  quotaExitCode,
  runTravelCommand,
  stateFailureExitCode,
  upstreamExitCode,
  usageExitCode,
} from './travel.mjs'

const scriptPath = new URL('./travel.mjs', import.meta.url)
const now = new Date('2027-06-11T12:00:00.000Z')
const serpApiFixtureKey = 'serp-fixture-secret'
const orsFixtureKey = 'ors-fixture-secret'
const tflFixtureKey = 'tfl-fixture-secret'
const aeroApiFixtureKey = 'aeroapi-fixture-secret'
const credentialEnvironmentNames = ['SERPAPI_API_KEY', 'ORS_API_KEY', 'TFL_APP_KEY', 'AEROAPI_API_KEY']
const travelEnvironmentNames = [...credentialEnvironmentNames, 'GLISSA_LOG_FILE', 'GLISSA_STATE_DIR', 'EXTRA_SECRET']
const flightStatusDate = '2027-06-12'
const flightStatusEndDate = '2027-06-13'
const flightStatusDateBeyondWindow = '2027-07-11'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function createQueuedFetch(...queuedResponses) {
  const requests = []
  const fetchImplementation = async (url, options) => {
    requests.push({ url: String(url), options })
    const queuedResponse = queuedResponses.shift()
    if (queuedResponse instanceof Error) throw queuedResponse
    if (!queuedResponse) throw new Error('Unexpected fake fetch request')
    return queuedResponse
  }
  return { fetchImplementation, requests, queuedResponses }
}

async function withTemporaryTravelFiles(testFunction) {
  return withTemporaryDirectory('glissa-travel-', async (temporaryDirectory) => {
    const envFilePath = join(temporaryDirectory, 'travel.env')
    const quotaFilePath = join(temporaryDirectory, 'context', 'travel-quota.json')
    const stateDirectory = join(temporaryDirectory, 'state')
    const restoreEnvironment = setTestEnvironment({
      ...Object.fromEntries(travelEnvironmentNames.map((name) => [name, undefined])),
      GLISSA_LOG_FILE: join(temporaryDirectory, 'glissa.jsonl'),
      GLISSA_STATE_DIR: stateDirectory,
    })
    try {
      await writeFile(envFilePath, `SERPAPI_API_KEY=${serpApiFixtureKey}\nORS_API_KEY=${orsFixtureKey}\nTFL_APP_KEY=${tflFixtureKey}\nAEROAPI_API_KEY=${aeroApiFixtureKey}\n`, { mode: 0o600 })
      await testFunction({ temporaryDirectory, envFilePath, quotaFilePath, stateDirectory })
    } finally {
      restoreEnvironment()
    }
  })
}

async function runTravel(paths, commandArguments, standardInput, fakeFetch) {
  return runTravelWithText(paths, commandArguments, JSON.stringify(standardInput), fakeFetch)
}

async function runTravelWithText(paths, commandArguments, standardInputText, fakeFetch = createQueuedFetch()) {
  const outputLines = []
  const errorLines = []
  const exitCode = await runTravelCommand(commandArguments, {
    envFilePath: paths.envFilePath,
    quotaFilePath: paths.quotaFilePath,
    now,
    fetchImplementation: fakeFetch.fetchImplementation,
    writeOutput: (line) => outputLines.push(line),
    writeError: (line) => errorLines.push(line),
    readStandardInput: async () => standardInputText,
  })
  return { exitCode, outputLines, errorLines }
}

async function runTravelCli(environment, standardInput, ...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments], { env: environment }, JSON.stringify(standardInput))
}

function createCliEnvironment(paths, overrides = {}) {
  const environment = { ...process.env, GLISSA_TRAVEL_ENV_FILE: paths.envFilePath, GLISSA_LOG_FILE: join(paths.temporaryDirectory, 'cli.log'), ...overrides }
  credentialEnvironmentNames.forEach((environmentName) => delete environment[environmentName])
  return environment
}

function flightFixture(price, flightNumber = `XY${price}`) {
  return {
    price,
    total_duration: price + 100,
    flights: [{
      airline: 'Example Air',
      flight_number: flightNumber,
      departure_airport: { name: 'Toronto', id: 'YYZ', time: '2027-06-27 10:00' },
      arrival_airport: { name: 'Lisbon', id: 'LIS', time: '2027-06-28 08:00' },
    }],
  }
}

function hotelFixture(price, name = `Hotel ${price}`) {
  return { name, rate_per_night: { lowest: `$${price}` }, overall_rating: 4.5, reviews: price * 10 }
}

function journeyFixture(duration, line = 'Example Line') {
  return {
    duration,
    legs: [{
      mode: { name: 'tube' },
      routeOptions: [{ name: line }],
      departurePoint: { commonName: 'Example Airport' },
      arrivalPoint: { commonName: 'Example Square' },
      departureTime: '2027-06-11T12:00:00Z',
    }],
  }
}

function applyMeasuredLinkRewriter(originalUrl) {
  const rewrittenUrl = new URL(originalUrl)
  rewrittenUrl.hostname = rewrittenUrl.hostname.replace(/^www\./, '')
  rewrittenUrl.pathname = rewrittenUrl.pathname.replace(/\/$/, '')
  rewrittenUrl.searchParams.sort()
  return rewrittenUrl.href
}

test('returns trimmed results for every command', async (t) => {
  const cases = [
    {
      name: 'flights',
      input: { from: 'YYZ', to: 'LIS', date: '2027-06-27', currency: 'USD' },
      responses: [jsonResponse({
        best_flights: [flightFixture(600), flightFixture(200), { price: 1 }],
        other_flights: [flightFixture(500), flightFixture(400), flightFixture(300), flightFixture(100)],
      })],
      verify(output) {
        assert.equal(output.flights.length, 5)
        assert.deepEqual(output.flights.map((flight) => flight.price), [100, 200, 300, 400, 500])
        assert.deepEqual(Object.keys(output.flights[0]), ['price', 'total_duration', 'stops', 'legs'])
        assert.deepEqual(Object.keys(output.flights[0].legs[0]), ['airline', 'flight_number', 'from', 'to', 'departure', 'arrival'])
      },
    },
    {
      name: 'hotels',
      input: { query: 'Example District Lisbon', checkIn: '2027-06-27', checkOut: '2027-06-30', maxPrice: '200', adults: '2' },
      responses: [jsonResponse({ properties: [...Array.from({ length: 11 }, (_, index) => hotelFixture(111 - index)), { name: 'Broken' }] })],
      verify(output) {
        assert.equal(output.hotels.length, 10)
        assert.deepEqual(output.hotels.map((hotel) => hotel.price), ['$101', '$102', '$103', '$104', '$105', '$106', '$107', '$108', '$109', '$110'])
        assert.deepEqual(Object.keys(output.hotels[0]), ['name', 'price', 'rating', 'review_count'])
      },
    },
    {
      name: 'status',
      input: { flight: 'XY101', date: flightStatusDate },
      responses: [jsonResponse({ flights: [
        { ident: 'XY101', origin: { code_iata: 'YYZ' }, destination: { code_iata: 'XYZ' }, status: 'En Route', scheduled_out: `${flightStatusDate}T10:00:00Z`, estimated_out: `${flightStatusDate}T10:10:00Z`, scheduled_in: `${flightStatusDate}T13:00:00Z`, estimated_in: `${flightStatusDate}T13:15:00Z`, gate_origin: 'E4', terminal_origin: '3', gate_destination: null, terminal_destination: 'A', arrival_delay: 900, cancelled: false },
        { ident: 'XY102', origin: { code_iata: 'YYZ' }, destination: {}, status: 'Scheduled' },
        { ident: 'XY103', origin: { code_iata: 'YYZ' }, destination: { code_iata: 'XYZ' } },
      ] })],
      verify(output) {
        assert.deepEqual(output, { flights: [
          { flight: 'XY101', from: 'YYZ', to: 'XYZ', status: 'En Route', scheduled_out: `${flightStatusDate}T10:00:00Z`, estimated_out: `${flightStatusDate}T10:10:00Z`, scheduled_in: `${flightStatusDate}T13:00:00Z`, estimated_in: `${flightStatusDate}T13:15:00Z`, gate_origin: 'E4', terminal_origin: '3', gate_destination: null, terminal_destination: 'A', arrival_delay_minutes: 15, cancelled: false },
          { flight: 'XY103', from: 'YYZ', to: 'XYZ', status: null, scheduled_out: null, estimated_out: null, scheduled_in: null, estimated_in: null, gate_origin: null, terminal_origin: null, gate_destination: null, terminal_destination: null, arrival_delay_minutes: null, cancelled: null },
        ] })
      },
      verifyFiles: async (paths) => assert.rejects(stat(paths.quotaFilePath), { code: 'ENOENT' }),
    },
    {
      name: 'route',
      input: { from: '45.68,-12.3', to: '45.69,-12.4', profile: 'foot-walking' },
      responses: [jsonResponse({ features: [{ properties: { summary: { distance: 1250, duration: 750 } } }] })],
      verify(output) {
        assert.deepEqual(output, { distance_km: 1.25, duration_minutes: 12.5, profile: 'foot-walking', from: '45.68,-12.3', to: '45.69,-12.4' })
      },
    },
    {
      name: 'journey',
      input: { from: 'ZZ1A 1ZZ', to: 'ZZ2 2ZZ' },
      responses: [jsonResponse({ journeys: [journeyFixture(45), { duration: 1 }, journeyFixture(35), journeyFixture(25), journeyFixture(15)] })],
      verify(output) {
        assert.equal(output.journeys.length, 3)
        assert.deepEqual(output.journeys.map((journey) => journey.duration), [45, 35, 25])
        assert.deepEqual(Object.keys(output.journeys[0].legs[0]), ['mode', 'line', 'from', 'to', 'departure'])
      },
    },
  ]
  for (const commandCase of cases) {
    await t.test(commandCase.name, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const fakeFetch = createQueuedFetch(...commandCase.responses)
        const commandResult = await runTravel(paths, [commandCase.name, '--stdin'], commandCase.input, fakeFetch)
        assert.equal(commandResult.exitCode, 0)
        assert.equal(commandResult.errorLines.length, 0)
        assert.equal(commandResult.outputLines.length, 1)
        commandCase.verify(JSON.parse(commandResult.outputLines[0]))
        if (commandCase.verifyFiles) await commandCase.verifyFiles(paths)
        assert.equal(fakeFetch.queuedResponses.length, 0)
      })
    })
  }
})

test('TfL walking legs with empty route option names remain in journeys', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const tflResponse = {
      journeys: [
        {
          duration: 33,
          legs: [
            { mode: { name: 'walking' }, routeOptions: [{ name: '' }], departurePoint: { commonName: 'ZZ1A 1ZZ' }, arrivalPoint: { commonName: 'Example Square Underground Station' }, departureTime: '2027-06-11T16:42:00' },
            { mode: { name: 'tube' }, routeOptions: [{ name: 'Example Express' }], departurePoint: { commonName: 'Example Square Underground Station' }, arrivalPoint: { commonName: 'Example Quay Underground Station' }, departureTime: '2027-06-11T16:55:00' },
            { mode: { name: 'walking' }, routeOptions: [{ name: '' }], departurePoint: { commonName: 'Example Quay Underground Station' }, arrivalPoint: { commonName: 'ZZ2 2ZZ' }, departureTime: '2027-06-11T17:07:00' },
          ],
        },
        {
          duration: 33,
          legs: [
            { mode: { name: 'walking' }, routeOptions: [{ name: '' }], departurePoint: { commonName: 'ZZ1A 1ZZ' }, arrivalPoint: { commonName: 'Example Square Underground Station' }, departureTime: '2027-06-11T16:45:00' },
            { mode: { name: 'tube' }, routeOptions: [{ name: 'Example Express' }], departurePoint: { commonName: 'Example Square Underground Station' }, arrivalPoint: { commonName: 'Example Quay Underground Station' }, departureTime: '2027-06-11T16:58:00' },
            { mode: { name: 'walking' }, routeOptions: [{ name: '' }], departurePoint: { commonName: 'Example Quay Underground Station' }, arrivalPoint: { commonName: 'ZZ2 2ZZ' }, departureTime: '2027-06-11T17:10:00' },
          ],
        },
      ],
    }
    const commandResult = await runTravel(paths, ['journey', '--stdin'], { from: 'ZZ1A 1ZZ', to: 'ZZ2 2ZZ' }, createQueuedFetch(jsonResponse(tflResponse)))
    const output = JSON.parse(commandResult.outputLines[0])
    assert.equal(commandResult.exitCode, 0)
    assert.equal(output.journeys.length, 2)
    assert.deepEqual(output.journeys.map((journey) => journey.legs.length), [3, 3])
    assert.deepEqual(output.journeys.map((journey) => journey.legs.filter((leg) => leg.mode === 'walking').map((leg) => leg.line)), [[null, null], [null, null]])
  })
})

test('one-way and return flight searches differ in URL and in the trip they report', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(
      jsonResponse({ best_flights: [flightFixture(300)] }),
      jsonResponse({ best_flights: [flightFixture(400)] }),
    )
    const oneWayResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, fakeFetch)
    const returnResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27', return: '2027-07-04' }, fakeFetch)
    const oneWayUrl = new URL(fakeFetch.requests[0].url)
    assert.equal(oneWayUrl.searchParams.has('return_date'), false)
    assert.equal(oneWayUrl.searchParams.get('type'), '2')
    const returnUrl = new URL(fakeFetch.requests[1].url)
    assert.equal(returnUrl.searchParams.get('return_date'), '2027-07-04')
    assert.equal(returnUrl.searchParams.get('type'), '1')
    const oneWayOutput = JSON.parse(oneWayResult.outputLines[0])
    const returnOutput = JSON.parse(returnResult.outputLines[0])
    assert.deepEqual(Object.keys(oneWayOutput), ['trip', 'flights'])
    assert.equal(oneWayOutput.trip, 'one-way')
    assert.deepEqual(Object.keys(returnOutput), ['trip', 'legs_shown', 'flights'])
    assert.equal(returnOutput.trip, 'round-trip')
    assert.equal(returnOutput.legs_shown, 'outbound')
  })
})

test('SerpApi URLs omit absent optional fields and retain a supplied currency', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(
      jsonResponse({ best_flights: [flightFixture(300)] }),
      jsonResponse({ properties: [hotelFixture(150)] }),
      jsonResponse({ best_flights: [flightFixture(400)] }),
      jsonResponse({ properties: [hotelFixture(160)] }),
    )
    await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, fakeFetch)
    await runTravel(paths, ['hotels', '--stdin'], { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28' }, fakeFetch)
    await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27', currency: 'EUR' }, fakeFetch)
    await runTravel(paths, ['hotels', '--stdin'], { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28', maxPrice: '150', currency: 'EUR' }, fakeFetch)
    const flightWithoutCurrencyUrl = new URL(fakeFetch.requests[0].url)
    const hotelWithoutOptionalFieldsUrl = new URL(fakeFetch.requests[1].url)
    const flightWithCurrencyUrl = new URL(fakeFetch.requests[2].url)
    const hotelWithCurrencyUrl = new URL(fakeFetch.requests[3].url)
    assert.equal(flightWithoutCurrencyUrl.searchParams.has('currency'), false)
    assert.equal(hotelWithoutOptionalFieldsUrl.searchParams.has('max_price'), false)
    assert.equal(hotelWithoutOptionalFieldsUrl.searchParams.has('adults'), false)
    assert.equal(hotelWithoutOptionalFieldsUrl.searchParams.has('currency'), false)
    assert.equal(flightWithCurrencyUrl.searchParams.get('currency'), 'EUR')
    assert.equal(hotelWithCurrencyUrl.searchParams.get('max_price'), '150')
    assert.equal(hotelWithCurrencyUrl.searchParams.get('currency'), 'EUR')
  })
})

test('named route geocodes both ends and sends directions in lon,lat order', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(
      jsonResponse({ features: [{ geometry: { coordinates: [-12.34, 45.67] }, properties: { label: 'Example Airport Airport' } }] }),
      jsonResponse({ features: [{ geometry: { coordinates: [-12.35, 45.68] }, properties: { label: 'Example Square' } }] }),
      jsonResponse({ features: [{ properties: { summary: { distance: 28000, duration: 2100 } } }] }),
    )
    const commandResult = await runTravel(paths, ['route', '--stdin'], { from: 'Example Airport', to: 'Example Square' }, fakeFetch)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(fakeFetch.requests.length, 3)
    assert.equal(new URL(fakeFetch.requests[0].url).searchParams.get('text'), 'Example Airport')
    assert.equal(new URL(fakeFetch.requests[1].url).searchParams.get('text'), 'Example Square')
    const directionsUrl = new URL(fakeFetch.requests[2].url)
    assert.equal(directionsUrl.searchParams.get('start'), '-12.34,45.67')
    assert.equal(directionsUrl.searchParams.get('end'), '-12.35,45.68')
    fakeFetch.requests.forEach((request) => assert.equal(request.options.headers.Authorization, orsFixtureKey))
  })
})

test('route country constrains both named geocodes and is omitted without a country', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const countryFetch = createQueuedFetch(
      jsonResponse({ features: [{ geometry: { coordinates: [-12.34, 45.67] }, properties: { label: 'Example Airport Airport, Lisbon, Portugal' } }] }),
      jsonResponse({ features: [{ geometry: { coordinates: [-12.35, 45.68] }, properties: { label: 'Example Square, Lisbon, Portugal' } }] }),
      jsonResponse({ features: [{ properties: { summary: { distance: 28000, duration: 2100 } } }] }),
    )
    const withoutCountryFetch = createQueuedFetch(
      jsonResponse({ features: [{ geometry: { coordinates: [-12.34, 45.67] }, properties: { label: 'Example Airport Airport' } }] }),
      jsonResponse({ features: [{ geometry: { coordinates: [-12.35, 45.68] }, properties: { label: 'Example Square' } }] }),
      jsonResponse({ features: [{ properties: { summary: { distance: 28000, duration: 2100 } } }] }),
    )
    const countryResult = await runTravel(paths, ['route', '--stdin'], { from: 'Example Airport Airport, Lisbon', to: 'Example Square', country: 'PRT' }, countryFetch)
    const withoutCountryResult = await runTravel(paths, ['route', '--stdin'], { from: 'Example Airport', to: 'Example Square' }, withoutCountryFetch)
    assert.equal(countryResult.exitCode, 0)
    assert.equal(withoutCountryResult.exitCode, 0)
    assert.equal(countryFetch.requests.length, 3)
    assert.equal(withoutCountryFetch.requests.length, 3)
    assert.equal(new URL(countryFetch.requests[0].url).searchParams.get('boundary.country'), 'PRT')
    assert.equal(new URL(countryFetch.requests[1].url).searchParams.get('boundary.country'), 'PRT')
    assert.equal(new URL(withoutCountryFetch.requests[0].url).searchParams.has('boundary.country'), false)
    assert.equal(new URL(withoutCountryFetch.requests[1].url).searchParams.has('boundary.country'), false)
  })
})

test('coordinate route makes one directions call', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(jsonResponse({ features: [{ properties: { summary: { distance: 1000, duration: 60 } } }] }))
    await runTravel(paths, ['route', '--stdin'], { from: '45.68,-12.3', to: '45.69,-12.4' }, fakeFetch)
    assert.equal(fakeFetch.requests.length, 1)
    assert.match(fakeFetch.requests[0].url, /directions\/driving-car/)
  })
})

test('journey status 300 returns one side of disambiguation with five options', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const optionsWithIcsCode = Array.from({ length: 5 }, (_, index) => ({ place: { commonName: `Station ${index}`, icsCode: `ID${index}` } }))
    const optionWithoutIcsCode = { place: { commonName: 'ZZ1A 1ZZ' } }
    const fakeFetch = createQueuedFetch(jsonResponse({
      fromLocationDisambiguation: { disambiguationOptions: [...optionsWithIcsCode.slice(0, 4), optionWithoutIcsCode, optionsWithIcsCode[4]] },
      toLocationDisambiguation: { disambiguationOptions: [{ place: { commonName: 'Other', icsCode: 'OTHER' } }] },
    }, 300))
    const commandResult = await runTravel(paths, ['journey', '--stdin'], { from: 'Example Bank', to: 'Example Pier' }, fakeFetch)
    assert.equal(commandResult.exitCode, ambiguousExitCode)
    assert.equal(commandResult.errorLines.length, 0)
    assert.deepEqual(JSON.parse(commandResult.outputLines[0]), {
      ambiguous: {
        field: 'from',
        options: [
          ...optionsWithIcsCode.slice(0, 4).map((option) => ({ label: option.place.commonName, id: option.place.icsCode })),
          { label: 'ZZ1A 1ZZ', id: null },
        ],
      },
    })
    const travelLogLine = (await readLoggedEvents(join(paths.temporaryDirectory, 'glissa.jsonl'))).at(-1)
    assert.equal(travelLogLine.status, ambiguousExitCode)
    assert.equal(travelLogLine.result_count, 5)
  })
})

test('rejected upstream credentials exit 3 without leaking a key', async (t) => {
  const cases = [
    { name: 'serpapi 401', command: 'flights', input: { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, status: 401, fixtureKey: serpApiFixtureKey },
    { name: 'openrouteservice 403', command: 'route', input: { from: '45.68,-12.3', to: '45.69,-12.4' }, status: 403, fixtureKey: orsFixtureKey },
  ]
  for (const rejectionCase of cases) {
    await t.test(rejectionCase.name, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const fakeFetch = createQueuedFetch(jsonResponse({ error: 'Invalid API key' }, rejectionCase.status))
        const commandResult = await runTravel(paths, [rejectionCase.command, '--stdin'], rejectionCase.input, fakeFetch)
        assert.equal(commandResult.exitCode, credentialsExitCode)
        assert.match(commandResult.errorLines[0], /Upstream rejected the travel credentials/)
        assert.doesNotMatch(commandResult.errorLines[0], new RegExp(rejectionCase.fixtureKey))
        assert.deepEqual(commandResult.outputLines, [])
      })
    })
  }
})

test('upstream status errors show the status without response body or key', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(jsonResponse({ error: 'raw-body-marker' }, 429))
    const commandResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, fakeFetch)
    assert.equal(commandResult.exitCode, upstreamExitCode)
    assert.match(commandResult.errorLines[0], /status 429/)
    assert.doesNotMatch(commandResult.errorLines[0], /raw-body-marker/)
    assert.doesNotMatch(commandResult.errorLines[0], new RegExp(serpApiFixtureKey))
    assert.match(commandResult.errorLines[0], /api_key=REDACTED/)
  })
})

test('directions 404 maps only OpenRouteService no-route responses to nothing found', async (t) => {
  const cases = [
    { name: 'no route', body: { error: { code: 2009, message: 'Route could not be found' } }, expectedExitCode: nothingFoundExitCode },
    { name: 'other error', body: { error: { code: 2010, message: 'Provider detail' } }, expectedExitCode: upstreamExitCode },
  ]
  for (const routeErrorCase of cases) {
    await t.test(routeErrorCase.name, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, ['route', '--stdin'], { from: '45.68,-12.3', to: '45.69,-12.4' }, createQueuedFetch(jsonResponse(routeErrorCase.body, 404)))
        assert.equal(commandResult.exitCode, routeErrorCase.expectedExitCode)
        assert.deepEqual(commandResult.outputLines, [])
        if (routeErrorCase.expectedExitCode === nothingFoundExitCode) assert.match(commandResult.errorLines[0], /No travel results found/)
        if (routeErrorCase.expectedExitCode === upstreamExitCode) assert.match(commandResult.errorLines[0], /status 404/)
      })
    })
  }
})

test('SerpApi 200 error is upstream failure without raw error text or key', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch(jsonResponse({ error: 'provider-secret-detail' }))
    const commandResult = await runTravel(paths, ['hotels', '--stdin'], {
      query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28',
    }, fakeFetch)
    assert.equal(commandResult.exitCode, upstreamExitCode)
    assert.doesNotMatch(commandResult.errorLines[0], /provider-secret-detail/)
    assert.doesNotMatch(commandResult.errorLines[0], new RegExp(serpApiFixtureKey))
  })
})

test('empty and entirely malformed results exit 5 without stdout', async (t) => {
  const cases = [
    ['flights', { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, { best_flights: [{ price: 100 }] }],
    ['hotels', { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28' }, { properties: [{ name: 'Missing rate' }] }],
    ['prices', { query: 'Example Chair' }, { shopping_results: [{ title: 'Example Chair', source: 'Example Store' }] }],
    ['status', { flight: 'XY101', date: flightStatusDate }, { flights: [{ ident: 'XY101' }] }],
    ['journey', { from: 'Example Bank', to: 'Example Pier' }, { journeys: [{ duration: 10 }] }],
  ]
  for (const [command, input, body] of cases) {
    await t.test(command, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, [command, '--stdin'], input, createQueuedFetch(jsonResponse(body)))
        assert.equal(commandResult.exitCode, nothingFoundExitCode)
        assert.deepEqual(commandResult.outputLines, [])
      })
    })
  }
})

test('a missing credential file permits keyless journeys and blocks flights', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const missingPaths = { ...paths, envFilePath: join(paths.temporaryDirectory, 'missing.env') }
    const journeyFetch = createQueuedFetch(jsonResponse({ journeys: [journeyFixture(30)] }))
    const journeyResult = await runTravel(missingPaths, ['journey', '--stdin'], { from: 'A', to: 'B' }, journeyFetch)
    const flightsResult = await runTravel(missingPaths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, createQueuedFetch())
    assert.equal(journeyResult.exitCode, 0)
    assert.equal(new URL(journeyFetch.requests[0].url).searchParams.has('app_key'), false)
    assert.equal(flightsResult.exitCode, credentialsExitCode)
    assert.match(flightsResult.errorLines[0], /Travel credentials are missing for flights/)
  })
})

test('insecure credential files exit 3 for every command', async (t) => {
  const cases = [
    ['flights', { from: 'YYZ', to: 'LIS', date: '2027-06-27' }],
    ['hotels', { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28' }],
    ['route', { from: '1,2', to: '3,4' }],
    ['journey', { from: 'A', to: 'B' }],
  ]
  for (const [command, input] of cases) {
    await t.test(command, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        await chmod(paths.envFilePath, 0o644)
        const commandResult = await runTravel(paths, [command, '--stdin'], input, createQueuedFetch())
        assert.equal(commandResult.exitCode, credentialsExitCode)
      })
    })
  }
})

test('incomplete credential files exit 3 without leaking fixture keys', async (t) => {
  const cases = [
    ['route', { from: '1,2', to: '3,4' }, orsFixtureKey],
    ['status', { flight: 'XY101', date: flightStatusDate }, aeroApiFixtureKey],
  ]
  for (const [command, input, fixtureKey] of cases) {
    await t.test(command, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        await writeFile(paths.envFilePath, `SERPAPI_API_KEY=${serpApiFixtureKey}\n`, { mode: 0o600 })
        await chmod(paths.envFilePath, 0o600)
        const missingKeyResult = await runTravel(paths, [command, '--stdin'], input, createQueuedFetch())
        assert.equal(missingKeyResult.exitCode, credentialsExitCode)
        assert.doesNotMatch(missingKeyResult.errorLines.join('\n'), new RegExp(fixtureKey))
      })
    })
  }
})

test('quota refuses at 200 without changing state', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await mkdir(join(paths.quotaFilePath, '..'), { recursive: true })
    await writeFile(paths.quotaFilePath, JSON.stringify({ month: '2027-06', count: 200 }))
    const commandResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, createQueuedFetch())
    assert.equal(commandResult.exitCode, quotaExitCode)
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: '2027-06', count: 200 })
  })
})

test('successful SerpApi search reserves one quota slot', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, createQueuedFetch(jsonResponse({ best_flights: [flightFixture(300)] })))
    assert.equal(commandResult.exitCode, 0)
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: '2027-06', count: 1 })
  })
})

test('the default quota file lives in Glissa state directory shared by every checkout', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel({ ...paths, quotaFilePath: undefined }, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, createQueuedFetch(jsonResponse({ best_flights: [flightFixture(300)] })))
    assert.equal(commandResult.exitCode, 0)
    assert.deepEqual(await readJsonFile(join(paths.stateDirectory, 'travel-quota.json')), { month: '2027-06', count: 1 })
  })
})

test('an extra credential file key never reaches the process environment or the output', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await writeFile(paths.envFilePath, `SERPAPI_API_KEY=${serpApiFixtureKey}\nORS_API_KEY=${orsFixtureKey}\nTFL_APP_KEY=${tflFixtureKey}\nEXTRA_SECRET=extra-fixture-secret\n`, { mode: 0o600 })
    const commandResult = await runTravel(paths, ['journey', '--stdin'], { from: 'Example Bank', to: 'Example Pier' }, createQueuedFetch(jsonResponse({ journeys: [journeyFixture(30)] })))
    assert.equal(commandResult.exitCode, 0)
    assert.equal(process.env.EXTRA_SECRET, undefined)
    assert.doesNotMatch([...commandResult.outputLines, ...commandResult.errorLines].join('\n'), /extra-fixture-secret/)
  })
})

test('a new month resets the SerpApi count before reservation', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await mkdir(join(paths.quotaFilePath, '..'), { recursive: true })
    await writeFile(paths.quotaFilePath, JSON.stringify({ month: '2027-05', count: 199 }))
    const commandResult = await runTravel(paths, ['hotels', '--stdin'], {
      query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28',
    }, createQueuedFetch(jsonResponse({ properties: [hotelFixture(150)] })))
    assert.equal(commandResult.exitCode, 0)
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: '2027-06', count: 1 })
  })
})

test('two concurrent quota reservations land at count 2', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const firstFetch = createQueuedFetch(jsonResponse({ best_flights: [flightFixture(300)] }))
    const secondFetch = createQueuedFetch(jsonResponse({ properties: [hotelFixture(150)] }))
    const commandResults = await Promise.all([
      runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, firstFetch),
      runTravel(paths, ['hotels', '--stdin'], { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28' }, secondFetch),
    ])
    assert.deepEqual(commandResults.map((commandResult) => commandResult.exitCode), [0, 0])
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: '2027-06', count: 2 })
  })
})

test('maplink builds a walking link with two stops and no waypoints', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch()
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: [' Example Hotel, Toronto ', 'Harbour Point, Toronto'] }, fakeFetch)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(fakeFetch.requests.length, 0)
    assert.deepEqual(JSON.parse(commandResult.outputLines[0]), {
      url: 'https://www.google.com/maps/dir/Example%20Hotel%2C%20Toronto/Harbour%20Point%2C%20Toronto/data=!4m2!4m1!3e2?travelmode=walking',
      telegramLink: '[Walking route: Example Hotel → Harbour Point](https://www.google.com/maps/dir/Example%20Hotel%2C%20Toronto/Harbour%20Point%2C%20Toronto/data=!4m2!4m1!3e2?travelmode=walking)',
      label: 'Walking route: Example Hotel → Harbour Point',
      mode: 'walking',
      stops: ['Example Hotel, Toronto', 'Harbour Point, Toronto'],
    })
  })
})

test('maplink preserves every stop in path order', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B', 'C', 'D', 'E'], mode: 'driving' })
    const mapLink = JSON.parse(commandResult.outputLines[0]).url
    assert.equal(commandResult.exitCode, 0)
    assert.match(mapLink, /\/A\/B\/C\/D\/E\/data=!4m2!4m1!3e0\?travelmode=driving$/)
    assert.match(mapLink, /travelmode=driving$/)
  })
})

test('maplink survives www stripping, slash stripping, and parameter sorting', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const stops = ['Example Hotel, Toronto', 'Example Plaza, Toronto', 'Harbour Point, Toronto']
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops })
    const mapLink = JSON.parse(commandResult.outputLines[0])
    const mapLinkUrl = new URL(mapLink.url)
    const encodedStops = stops.map((stop) => encodeURIComponent(stop).replaceAll('(', '%28').replaceAll(')', '%29'))
    assert.equal(mapLinkUrl.pathname.endsWith('/'), false)
    assert.deepEqual([...mapLinkUrl.searchParams.keys()], ['travelmode'])
    assert.deepEqual(mapLinkUrl.pathname.split('/').slice(3), [...encodedStops, 'data=!4m2!4m1!3e2'])
    const rewrittenDocumentedForm = new URL(applyMeasuredLinkRewriter('https://www.google.com/maps/dir/?api=1&origin=A&destination=B&travelmode=walking'))
    assert.equal(rewrittenDocumentedForm.pathname, '/maps/dir')
    const rewrittenMapLinkUrl = new URL(applyMeasuredLinkRewriter(mapLink.url))
    assert.equal(rewrittenMapLinkUrl.pathname, mapLinkUrl.pathname)
    assert.equal(rewrittenMapLinkUrl.search, mapLinkUrl.search)
    assert.equal(rewrittenMapLinkUrl.host, 'google.com')
  })
})

test('maplink rejects a stop that is only dots', async (t) => {
  for (const dotOnlyStop of ['.', '..', '...']) {
    await t.test(dotOnlyStop, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: [dotOnlyStop, 'B'] })
        assert.equal(commandResult.exitCode, usageExitCode)
        assert.match(commandResult.errorLines[0], /only dots/)
      })
    })
  }
})

test('maplink keeps every path segment when a stop only resembles a dot segment', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['..a', 'a..', '%2e%2e', 'B'] })
    const mapLink = JSON.parse(commandResult.outputLines[0]).url
    const rawPath = mapLink.slice(mapLink.indexOf('/maps/'), mapLink.indexOf('?'))
    assert.equal(commandResult.exitCode, 0)
    assert.equal(new URL(mapLink).pathname.startsWith('/maps/dir/'), true)
    assert.equal(new URL(mapLink).pathname.split('/').length, rawPath.split('/').length)
  })
})

test('maplink maps every mode to its Google path digit and travelmode parameter', async (t) => {
  const modeDigits = new Map([['driving', '0'], ['bicycling', '1'], ['walking', '2'], ['transit', '3']])
  for (const [mode, modeDigit] of modeDigits) {
    await t.test(mode, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B'], mode })
        const mapLinkUrl = new URL(JSON.parse(commandResult.outputLines[0]).url)
        assert.equal(mapLinkUrl.pathname.split('/').at(-1), `data=!4m2!4m1!3e${modeDigit}`)
        assert.equal(mapLinkUrl.searchParams.get('travelmode'), mode)
      })
    })
  }
})

test('maplink encodes reserved path-segment characters in a stop', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const stop = 'A/B?C#D%E+F'
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: [stop, 'Destination'] })
    const encodedStop = new URL(JSON.parse(commandResult.outputLines[0]).url).pathname.split('/')[3]
    const encodedStopWithoutEscapes = encodedStop.replaceAll(/%[0-9A-F]{2}/g, '')
    assert.equal(encodedStop, encodeURIComponent(stop))
    for (const reservedCharacter of ['/', '?', '#', '%', '+']) assert.equal(encodedStopWithoutEscapes.includes(reservedCharacter), false)
  })
})

test('maplink encodes reserved characters in every stop', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ["O'Example & Market, Toronto", 'Example Hotel, Toronto'] })
    const mapLink = JSON.parse(commandResult.outputLines[0]).url
    assert.match(mapLink, /O'Example%20%26%20Market%2C%20Toronto/)
    assert.equal(mapLink.includes('+'), false)
    assert.equal(mapLink.includes('O\'Example & Market, Toronto'), false)
  })
})

test('maplink encodes stop parentheses in the URL and keeps the Telegram link delimiters intact', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['Pier 10 (entrance), Toronto', 'Example Hotel, Toronto'] })
    const mapLink = JSON.parse(commandResult.outputLines[0])
    assert.match(mapLink.url, /%28entrance%29/)
    assert.equal(mapLink.url.includes('('), false)
    assert.equal(mapLink.url.includes(')'), false)
    assert.equal((mapLink.telegramLink.match(/(?<!\\)\]\(/g) ?? []).length, 1)
    assert.match(mapLink.telegramLink, /(?<!\\)\)$/)
  })
})

test('maplink escapes MarkdownV2 label characters while retaining the unescaped label', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B'], label: 'A. - B! (C) _D_' })
    const mapLink = JSON.parse(commandResult.outputLines[0])
    assert.equal(mapLink.label, 'A. - B! (C) _D_')
    assert.equal(mapLink.telegramLink.startsWith('[A\\. \\- B\\! \\(C\\) \\_D\\_]('), true)
  })
})

test('maplink uses a custom label and rejects invalid labels', async (t) => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B'], label: 'Lunch walk' })
    assert.equal(JSON.parse(commandResult.outputLines[0]).label, 'Lunch walk')
  })
  const invalidLabels = ['', ' ', 3, 'x'.repeat(121)]
  for (const label of invalidLabels) {
    await t.test(JSON.stringify(label), async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B'], label })
        assert.equal(commandResult.exitCode, usageExitCode)
      })
    })
  }
})

test('maplink retains a latitude longitude stop in the default label', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['12.3456, -123.4567', 'Example Hotel, Toronto'] })
    assert.equal(JSON.parse(commandResult.outputLines[0]).label, 'Walking route: 12.3456, -123.4567 → Example Hotel')
  })
})

test('maplink keeps an out of range latitude longitude stop whole in the default label', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['-123.4567, 12.3456', 'Example Hotel, Toronto'] })
    assert.equal(commandResult.exitCode, 0)
    assert.equal(JSON.parse(commandResult.outputLines[0]).label, 'Walking route: -123.4567, 12.3456 → Example Hotel')
  })
})

test('maplink rejects invalid stop counts, stops, modes, and transit waypoints', async (t) => {
  const cases = [
    [{ stops: ['A', 'B', 'C', 'D', 'E', 'F'] }, /split the outing into separate links/],
    [{ stops: ['A'] }, /at least two stops/],
    [{ stops: ['A', ''] }, /non-empty strings/],
    [{ stops: ['A', ' '] }, /non-empty strings/],
    [{ stops: ['A|B', 'C'] }, /pipe character/],
    [{ stops: ['A', 'B'], mode: 'flying' }, /mode is invalid/],
    [{ stops: ['A', 'B', 'C'], mode: 'transit' }, /one link per transit leg/],
  ]
  for (const [input, errorPattern] of cases) {
    await t.test(JSON.stringify(input), async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravel(paths, ['maplink', '--stdin'], input)
        assert.equal(commandResult.exitCode, usageExitCode)
        assert.match(commandResult.errorLines[0], errorPattern)
      })
    })
  }
})

test('maplink accepts a two-stop transit link without credentials or fetches', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const fakeFetch = createQueuedFetch()
    const missingPaths = { ...paths, envFilePath: join(paths.temporaryDirectory, 'missing.env') }
    const commandResult = await runTravel(missingPaths, ['maplink', '--stdin'], { stops: ['A', 'B'], mode: 'transit' }, fakeFetch)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(fakeFetch.requests.length, 0)
    assert.equal(JSON.parse(commandResult.outputLines[0]).mode, 'transit')
  })
})

test('maplink rejects unknown input fields', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['maplink', '--stdin'], { stops: ['A', 'B'], extra: 'x' })
    assert.equal(commandResult.exitCode, usageExitCode)
    assert.equal(commandResult.errorLines[0], 'Unknown travel input fields: extra')
  })
})

test('unreadable quota state exits 255 without fetching', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await mkdir(join(paths.quotaFilePath, '..'), { recursive: true })
    await writeFile(paths.quotaFilePath, '{')
    const fakeFetch = createQueuedFetch()
    const commandResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, fakeFetch)
    assert.equal(commandResult.exitCode, stateFailureExitCode)
    assert.equal(fakeFetch.requests.length, 0)
    assert.equal(await readFile(paths.quotaFilePath, 'utf8'), '{')
  })
})

test('a held quota lock exits 4 without fetching or changing the quota file', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await mkdir(join(paths.quotaFilePath, '..'), { recursive: true })
    await writeFile(paths.quotaFilePath, JSON.stringify({ month: '2027-06', count: 7 }))
    await writeFile(`${paths.quotaFilePath}.lock`, '')
    const fakeFetch = createQueuedFetch()
    const commandResult = await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, fakeFetch)
    assert.equal(commandResult.exitCode, upstreamExitCode)
    assert.match(commandResult.errorLines[0], /Travel quota lock is busy/)
    assert.equal(fakeFetch.requests.length, 0)
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: '2027-06', count: 7 })
  })
})

test('usage errors exit 2 before credentials or fetch are needed', async (t) => {
  const cases = [
    [['unknown', '--stdin'], '{}'],
    [['flights'], JSON.stringify({ from: 'YYZ', to: 'LIS', date: '2027-06-27' })],
    [['flights', '--stdin'], JSON.stringify({ from: 'YYZ', to: 'LIS', date: '2027-06-27', extra: 'x' })],
    [['flights', '--stdin'], JSON.stringify({ from: 'YYZ', to: 'LIS', date: 20270627 })],
    [['flights', '--stdin'], JSON.stringify({ from: 'yyz', to: 'LIS', date: '2027-06-27' })],
    [['flights', '--stdin'], JSON.stringify({ from: 'YYZ', to: 'LIS', date: '2027-02-30' })],
    [['flights', '--stdin'], JSON.stringify({ from: 'YYZ', to: 'LIS', date: '2027-06-27', return: '2027-06-26' })],
    [['route', '--stdin'], JSON.stringify({ from: 'Example Airport', to: 'Example Square', country: 'prt' })],
    [['status', '--stdin'], JSON.stringify({ flight: 'AB', date: flightStatusDate })],
    [['status', '--stdin'], JSON.stringify({ flight: 'XY101', date: '2027-13-01' })],
    [['status', '--stdin'], JSON.stringify({ flight: 'XY101', date: flightStatusDateBeyondWindow })],
  ]
  for (const [commandArguments, standardInputText] of cases) {
    await t.test(commandArguments.join(' '), async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const commandResult = await runTravelWithText(paths, commandArguments, standardInputText)
        assert.equal(commandResult.exitCode, usageExitCode)
        assert.deepEqual(commandResult.outputLines, [])
      })
    })
  }
})

test('fake fetch records keys only in the upstream locations that accept query keys', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const flightsFetch = createQueuedFetch(jsonResponse({ best_flights: [flightFixture(300)] }))
    const hotelsFetch = createQueuedFetch(jsonResponse({ properties: [hotelFixture(150)] }))
    const routeFetch = createQueuedFetch(jsonResponse({ features: [{ properties: { summary: { distance: 1000, duration: 60 } } }] }))
    const journeyFetch = createQueuedFetch(jsonResponse({ journeys: [journeyFixture(30)] }))
    const statusFetch = createQueuedFetch(jsonResponse({ flights: [{ ident: 'XY101', origin: { code_iata: 'YYZ' }, destination: { code_iata: 'XYZ' } }] }))
    await runTravel(paths, ['flights', '--stdin'], { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, flightsFetch)
    await runTravel(paths, ['hotels', '--stdin'], { query: 'Example District', checkIn: '2027-06-27', checkOut: '2027-06-28' }, hotelsFetch)
    await runTravel(paths, ['route', '--stdin'], { from: '1,2', to: '3,4' }, routeFetch)
    await runTravel(paths, ['journey', '--stdin'], { from: 'Example Bank', to: 'Example Pier' }, journeyFetch)
    await runTravel(paths, ['status', '--stdin'], { flight: 'XY101', date: flightStatusDate }, statusFetch)
    const flightsUrl = new URL(flightsFetch.requests[0].url)
    assert.equal(flightsUrl.origin + flightsUrl.pathname, 'https://serpapi.com/search.json')
    assert.equal(flightsUrl.searchParams.get('engine'), 'google_flights')
    assert.equal(flightsUrl.searchParams.get('departure_id'), 'YYZ')
    assert.equal(flightsUrl.searchParams.get('arrival_id'), 'LIS')
    assert.equal(flightsUrl.searchParams.get('outbound_date'), '2027-06-27')
    assert.equal(flightsUrl.searchParams.get('api_key'), serpApiFixtureKey)
    const hotelsUrl = new URL(hotelsFetch.requests[0].url)
    assert.equal(hotelsUrl.origin + hotelsUrl.pathname, 'https://serpapi.com/search.json')
    assert.equal(hotelsUrl.searchParams.get('engine'), 'google_hotels')
    assert.equal(hotelsUrl.searchParams.get('q'), 'Example District')
    assert.equal(hotelsUrl.searchParams.get('check_in_date'), '2027-06-27')
    assert.equal(hotelsUrl.searchParams.get('check_out_date'), '2027-06-28')
    assert.equal(hotelsUrl.searchParams.get('api_key'), serpApiFixtureKey)
    assert.equal(routeFetch.requests[0].url.includes(orsFixtureKey), false)
    assert.equal(routeFetch.requests[0].options.headers.Authorization, orsFixtureKey)
    const journeyUrl = new URL(journeyFetch.requests[0].url)
    assert.equal(journeyUrl.pathname, '/Journey/JourneyResults/Example%20Bank/to/Example%20Pier')
    assert.equal(journeyUrl.searchParams.get('app_key'), tflFixtureKey)
    const statusUrl = new URL(statusFetch.requests[0].url)
    assert.equal(statusUrl.searchParams.get('ident_type'), 'designator')
    assert.equal(statusUrl.searchParams.get('start'), flightStatusDate)
    assert.equal(statusUrl.searchParams.get('end'), flightStatusEndDate)
    assert.equal(statusUrl.href.includes(aeroApiFixtureKey), false)
    assert.equal(statusUrl.searchParams.has('api_key'), false)
    assert.equal(statusUrl.searchParams.has('x-apikey'), false)
    assert.equal(statusFetch.requests[0].options.headers['x-apikey'], aeroApiFixtureKey)
  })
})

test('a rejected flight status request exits 2 without stdout', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const commandResult = await runTravel(paths, ['status', '--stdin'], { flight: 'XY9999', date: flightStatusDate }, createQueuedFetch(jsonResponse({ title: 'Invalid ident' }, 400)))
    assert.equal(commandResult.exitCode, usageExitCode)
    assert.deepEqual(commandResult.outputLines, [])
  })
})

test('keyless TfL request omits app_key', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    delete process.env.TFL_APP_KEY
    await writeFile(paths.envFilePath, `SERPAPI_API_KEY=${serpApiFixtureKey}\nORS_API_KEY=${orsFixtureKey}\n`, { mode: 0o600 })
    const fakeFetch = createQueuedFetch(jsonResponse({ journeys: [journeyFixture(30)] }))
    const commandResult = await runTravel(paths, ['journey', '--stdin'], { from: 'Example Bank', to: 'Example Pier' }, fakeFetch)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(new URL(fakeFetch.requests[0].url).searchParams.has('app_key'), false)
  })
})

test('GLISSA_TRAVEL_ENV_FILE controls the CLI environment path', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    await chmod(paths.envFilePath, 0o644)
    const environment = createCliEnvironment(paths)
    const commandResult = await runTravelCli(environment, { from: 'Example Bank', to: 'Example Pier' }, 'journey', '--stdin')
    assert.equal(commandResult.exitCode, credentialsExitCode)
    assert.match(commandResult.stderr, new RegExp(paths.envFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('GLISSA_TRAVEL_QUOTA_FILE controls the CLI quota path', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const currentMonth = new Date().toISOString().slice(0, 7)
    await mkdir(join(paths.quotaFilePath, '..'), { recursive: true })
    await writeFile(paths.quotaFilePath, JSON.stringify({ month: currentMonth, count: 200 }))
    const environment = createCliEnvironment(paths, { GLISSA_TRAVEL_QUOTA_FILE: paths.quotaFilePath })
    const commandResult = await runTravelCli(environment, { from: 'YYZ', to: 'LIS', date: '2027-06-27' }, 'flights', '--stdin')
    assert.equal(commandResult.exitCode, quotaExitCode)
    assert.deepEqual(await readJsonFile(paths.quotaFilePath), { month: currentMonth, count: 200 })
  })
})

function listedPriceFixture(priceValue, overrides = {}) {
  return { position: 1, title: 'Example Chair', source: 'Example Store', price: `$${priceValue}.00`, extracted_price: priceValue, product_link: 'https://shopping.example/product', ...overrides }
}

test('prices searches shopping listings by product and country and trims each listing', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const pricesFetch = createQueuedFetch(jsonResponse({ shopping_results: [
      listedPriceFixture(714, { multiple_sources: true, rating: 4.8, reviews: 7700 }),
      listedPriceFixture(1035, { source: 'Other Store', old_price: '$1,174', tag: '11% OFF', delivery: 'Free delivery', second_hand_condition: 'refurbished' }),
    ] }))
    const commandResult = await runTravel(paths, ['prices', '--stdin'], { query: 'Example Chair', country: 'GB' }, pricesFetch)
    const pricesUrl = new URL(pricesFetch.requests[0].url)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(pricesUrl.searchParams.get('engine'), 'google_shopping')
    assert.equal(pricesUrl.searchParams.get('q'), 'Example Chair')
    assert.equal(pricesUrl.searchParams.get('gl'), 'gb')
    assert.equal(pricesUrl.searchParams.get('hl'), 'en')
    assert.deepEqual(JSON.parse(commandResult.outputLines[0]).prices, [
      { title: 'Example Chair', seller: 'Example Store', price: '$714.00', priceValue: 714, rating: 4.8, reviews: 7700, hasOtherSellers: true },
      { title: 'Example Chair', seller: 'Other Store', price: '$1035.00', priceValue: 1035, wasPrice: '$1,174', discount: '11% OFF', condition: 'refurbished', delivery: 'Free delivery', hasOtherSellers: false },
    ])
    assert.equal((await readJsonFile(paths.quotaFilePath)).count, 1)
  })
})

test('prices defaults to the United States and keeps the first ten priced listings in listed order', async () => {
  await withTemporaryTravelFiles(async (paths) => {
    const pricedListings = Array.from({ length: 12 }, (unusedValue, listingIndex) => listedPriceFixture(120 - listingIndex))
    const pricesFetch = createQueuedFetch(jsonResponse({ shopping_results: [{ title: 'No price', source: 'Example Store' }, ...pricedListings] }))
    const commandResult = await runTravel(paths, ['prices', '--stdin'], { query: 'Example Chair' }, pricesFetch)
    const listedPrices = JSON.parse(commandResult.outputLines[0]).prices
    assert.equal(new URL(pricesFetch.requests[0].url).searchParams.get('gl'), 'us')
    assert.deepEqual(listedPrices.map((listedPrice) => listedPrice.priceValue), [120, 119, 118, 117, 116, 115, 114, 113, 112, 111])
  })
})

test('prices rejects an overlong query or a malformed country without spending a search', async (t) => {
  const cases = [
    ['overlong query', { query: 'x'.repeat(121) }],
    ['three-letter country', { query: 'Example Chair', country: 'usa' }],
    ['blank query', { query: ' ' }],
  ]
  for (const [caseName, input] of cases) {
    await t.test(caseName, async () => {
      await withTemporaryTravelFiles(async (paths) => {
        const pricesFetch = createQueuedFetch()
        const commandResult = await runTravel(paths, ['prices', '--stdin'], input, pricesFetch)
        assert.equal(commandResult.exitCode, usageExitCode)
        assert.equal(pricesFetch.requests.length, 0)
        await assert.rejects(stat(paths.quotaFilePath), { code: 'ENOENT' })
      })
    })
  }
})
