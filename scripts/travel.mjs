import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { isCalendarDate } from './calendar-date.mjs'
import { resolveGlissaStateDirectory } from './glissa-state-directory.mjs'
import { escapeReservedCharacters } from './brief-format.mjs'
import { addUsageExitCode, isMainModule, nothingToDoExitCode, readProcessStandardInput, runCommandLine, unreadableStateExitCode } from './command-line.mjs'
import { readJsonFile, withJsonFileLock, writeJsonFileAtomically } from './json-file.mjs'
import { logEvent } from './log.mjs'
import { isPlainObject, validateStringFields } from './object-fields.mjs'

export const usageExitCode = addUsageExitCode
export const credentialsExitCode = 3
export const upstreamExitCode = 4
export const nothingFoundExitCode = nothingToDoExitCode
export const quotaExitCode = 6
export const ambiguousExitCode = 7
export const stateFailureExitCode = unreadableStateExitCode

const serpApiMonthlyLimit = 200
const fetchTimeoutMs = 15_000
const millisecondsPerDay = 86_400_000
const maxPriceQueryLength = 120
const maxListedPrices = 10
const aeroApiOldestDaysPast = 10
const aeroApiFurthestDaysAhead = 2
const routeProfiles = new Set(['driving-car', 'foot-walking', 'cycling-regular'])
const mapLinkModeDigits = new Map([['driving', 0], ['bicycling', 1], ['walking', 2], ['transit', 3]])
const credentialRejectionStatuses = new Set([401, 403])
const commandInputFields = {
  flights: { required: ['from', 'to', 'date'], optional: ['return', 'currency'] },
  hotels: { required: ['query', 'checkIn', 'checkOut'], optional: ['maxPrice', 'adults', 'currency'] },
  status: { required: ['flight', 'date'], optional: [] },
  route: { required: ['from', 'to'], optional: ['profile', 'country'] },
  maplink: { required: ['stops'], optional: ['mode', 'label'] },
  journey: { required: ['from', 'to'], optional: [] },
  prices: { required: ['query'], optional: ['country'] },
}

class TravelUsageError extends Error {}

class TravelOperationalError extends Error {
  constructor(message, exitCode, details = {}) {
    super(message)
    this.exitCode = exitCode
    Object.assign(this, details)
  }
}

function getTravelEnvironmentFilePath(environment = process.env) {
  return environment.GLISSA_TRAVEL_ENV_FILE || resolve(homedir(), '.config/glissa/travel.env')
}

function getTravelQuotaFilePath(environment = process.env) {
  if (environment.GLISSA_TRAVEL_QUOTA_FILE) return environment.GLISSA_TRAVEL_QUOTA_FILE
  return resolve(resolveGlissaStateDirectory(environment), 'travel-quota.json')
}

function redactUrl(message, secretValues = []) {
  let redactedMessage = String(message).replace(/([?&](?:api_key|app_key)=)[^&\s]*/giu, '$1REDACTED')
  for (const secretValue of secretValues) {
    if (typeof secretValue !== 'string' || !secretValue) continue
    redactedMessage = redactedMessage.split(secretValue).join('REDACTED')
    redactedMessage = redactedMessage.split(encodeURIComponent(secretValue)).join('REDACTED')
  }
  return redactedMessage
}

function stripOneSurroundingQuotePair(value) {
  const quotedMatch = /^(["'])([\s\S]*)\1$/u.exec(value)
  if (!quotedMatch) return value
  return quotedMatch[2]
}

function parseEnvironmentFileText(environmentFileText) {
  const parsedAssignments = new Map()
  for (const rawLine of environmentFileText.split('\n')) {
    const assignmentText = rawLine.trim().replace(/^export\s+/u, '')
    if (!assignmentText || assignmentText.startsWith('#')) continue
    const separatorIndex = assignmentText.indexOf('=')
    if (separatorIndex <= 0) continue
    const name = assignmentText.slice(0, separatorIndex).trim()
    parsedAssignments.set(name, stripOneSurroundingQuotePair(assignmentText.slice(separatorIndex + 1).trim()))
  }
  return parsedAssignments
}

async function loadTravelCredentials(environmentFilePath) {
  let environmentFileStats
  try {
    environmentFileStats = await stat(environmentFilePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { serpApiKey: undefined, orsApiKey: undefined, tflAppKey: undefined, aeroApiKey: undefined }
    }
    throw new TravelOperationalError(`Travel credentials are unavailable: ${environmentFilePath}`, credentialsExitCode)
  }
  const environmentFileMode = environmentFileStats.mode & 0o777
  if ((environmentFileMode & 0o077) !== 0) {
    throw new TravelOperationalError(`Refusing to read ${environmentFilePath}: mode ${environmentFileMode.toString(8)} is readable beyond the owner`, credentialsExitCode)
  }
  let environmentFileText
  try {
    environmentFileText = await readFile(environmentFilePath, 'utf8')
  } catch {
    throw new TravelOperationalError(`Travel credentials are unavailable: ${environmentFilePath}`, credentialsExitCode)
  }
  const environmentFileAssignments = parseEnvironmentFileText(environmentFileText)
  return {
    serpApiKey: environmentFileAssignments.get('SERPAPI_API_KEY'),
    orsApiKey: environmentFileAssignments.get('ORS_API_KEY'),
    tflAppKey: environmentFileAssignments.get('TFL_APP_KEY'),
    aeroApiKey: environmentFileAssignments.get('AEROAPI_API_KEY'),
  }
}

function requireCredential(credentials, credentialName, command) {
  const credentialValue = credentials[credentialName]
  if (typeof credentialValue === 'string' && credentialValue.trim()) return credentialValue.trim()
  throw new TravelOperationalError(`Travel credentials are missing for ${command}`, credentialsExitCode)
}

async function readTravelInput(command, readStandardInput) {
  let travelInput
  try {
    travelInput = JSON.parse(await readStandardInput())
  } catch {
    throw new TravelUsageError('Invalid travel input JSON')
  }
  if (!isPlainObject(travelInput)) throw new TravelUsageError('Travel input must be a JSON object')
  const { required, optional } = commandInputFields[command]
  const allowedFields = new Set([...required, ...optional])
  const stringTravelInput = command === 'maplink'
    ? Object.fromEntries(Object.entries(travelInput).filter(([fieldName]) => fieldName !== 'stops'))
    : travelInput
  const inputFieldNames = validateStringFields(stringTravelInput, allowedFields, { inputName: 'Travel input', ErrorType: TravelUsageError })
  if (command === 'maplink') {
    if (!Object.hasOwn(travelInput, 'stops')) throw new TravelUsageError('Missing travel input fields: stops')
    if (!Array.isArray(travelInput.stops)) throw new TravelUsageError('Travel input field stops must be an array')
    return { ...Object.fromEntries(inputFieldNames.map((fieldName) => [fieldName, travelInput[fieldName].trim()])), stops: travelInput.stops }
  }
  const missingFieldNames = required.filter((fieldName) => !travelInput[fieldName]?.trim())
  if (missingFieldNames.length > 0) throw new TravelUsageError(`Missing travel input fields: ${missingFieldNames.join(', ')}`)
  return Object.fromEntries(inputFieldNames.map((fieldName) => [fieldName, travelInput[fieldName].trim()]))
}

function countDaysFromTodayUtc(calendarDate, now) {
  const requestedDayStart = Date.parse(`${calendarDate}T00:00:00.000Z`)
  const todayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  return Math.round((requestedDayStart - todayStart) / millisecondsPerDay)
}

function validateFlightInput(travelInput) {
  if (!/^[A-Z]{3}$/.test(travelInput.from) || !/^[A-Z]{3}$/.test(travelInput.to)) throw new TravelUsageError('Flight airports must be uppercase IATA codes')
  if (!isCalendarDate(travelInput.date)) throw new TravelUsageError('Flight date is invalid')
  if (travelInput.return && !isCalendarDate(travelInput.return)) throw new TravelUsageError('Flight return date is invalid')
  if (travelInput.return && travelInput.return < travelInput.date) throw new TravelUsageError('Flight return date cannot be before departure')
  if (travelInput.currency && !/^[A-Z]{3}$/.test(travelInput.currency)) throw new TravelUsageError('Flight currency must be an uppercase three-letter code')
  return travelInput
}

function validateHotelInput(travelInput) {
  if (!isCalendarDate(travelInput.checkIn) || !isCalendarDate(travelInput.checkOut)) throw new TravelUsageError('Hotel dates are invalid')
  if (travelInput.checkOut <= travelInput.checkIn) throw new TravelUsageError('Hotel check-out must be after check-in')
  if (travelInput.maxPrice && (!/^\d+(?:\.\d{1,2})?$/.test(travelInput.maxPrice) || Number(travelInput.maxPrice) <= 0)) throw new TravelUsageError('Hotel maxPrice must be a positive amount')
  if (travelInput.adults && (!/^\d+$/.test(travelInput.adults) || Number(travelInput.adults) < 1)) throw new TravelUsageError('Hotel adults must be a positive integer')
  if (travelInput.currency && !/^[A-Z]{3}$/.test(travelInput.currency)) throw new TravelUsageError('Hotel currency must be an uppercase three-letter code')
  return travelInput
}

function validatePriceInput(travelInput) {
  if (travelInput.query.length > maxPriceQueryLength) throw new TravelUsageError(`Price query must be at most ${maxPriceQueryLength} characters`)
  if (travelInput.country && !/^[A-Za-z]{2}$/.test(travelInput.country)) throw new TravelUsageError('Price country must be a two-letter code')
  return travelInput
}

function validateFlightStatusInput(travelInput, now) {
  if (!/^[A-Z0-9]{2,3}\d{1,4}$/.test(travelInput.flight)) throw new TravelUsageError('Flight number is invalid')
  if (!isCalendarDate(travelInput.date)) throw new TravelUsageError('Flight date is invalid')
  const daysFromToday = countDaysFromTodayUtc(travelInput.date, now)
  if (daysFromToday < -aeroApiOldestDaysPast || daysFromToday > aeroApiFurthestDaysAhead) throw new TravelUsageError('Flight date must be within 10 days past and 2 days ahead')
  return travelInput
}

function validateRouteInput(travelInput) {
  const profile = travelInput.profile || 'driving-car'
  if (!routeProfiles.has(profile)) throw new TravelUsageError('Route profile is invalid')
  if (travelInput.country && !/^[A-Z]{3}$/.test(travelInput.country)) throw new TravelUsageError('Route country must be an uppercase ISO 3166-1 alpha-3 code')
  return { ...travelInput, profile }
}

function validateMapLinkInput(travelInput) {
  if (travelInput.stops.length < 2) throw new TravelUsageError('Map link requires at least two stops')
  if (travelInput.stops.length > 5) throw new TravelUsageError('Map link has too many stops; split the outing into separate links')
  if (travelInput.stops.some((stop) => typeof stop !== 'string' || !stop.trim())) throw new TravelUsageError('Map link stops must be non-empty strings')
  const stops = travelInput.stops.map((stop) => stop.trim())
  if (stops.some((stop) => stop.includes('|'))) throw new TravelUsageError('Map link stops cannot contain a pipe character')
  if (stops.some((stop) => /^\.+$/.test(stop))) throw new TravelUsageError('Map link stop cannot be only dots')
  const mode = travelInput.mode || 'walking'
  if (!mapLinkModeDigits.has(mode)) throw new TravelUsageError('Map link mode is invalid')
  if (mode === 'transit' && stops.length > 2) throw new TravelUsageError('Transit map links require one link per transit leg')
  if (travelInput.label !== undefined && !travelInput.label) throw new TravelUsageError('Map link label must be a non-empty string')
  if (travelInput.label?.length > 120) throw new TravelUsageError('Map link label must be 120 characters or fewer')
  return { stops, mode, label: travelInput.label }
}

function validateCommandInput(command, travelInput, now) {
  if (command === 'flights') return validateFlightInput(travelInput)
  if (command === 'hotels') return validateHotelInput(travelInput)
  if (command === 'status') return validateFlightStatusInput(travelInput, now)
  if (command === 'route') return validateRouteInput(travelInput)
  if (command === 'maplink') return validateMapLinkInput(travelInput)
  if (command === 'prices') return validatePriceInput(travelInput)
  return travelInput
}

async function fetchJson(url, { headers = {}, acceptedStatuses = [200], fetchImplementation }) {
  let response
  try {
    response = await fetchImplementation(url, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) })
  } catch (error) {
    throw new TravelOperationalError(`Upstream request failed at ${url}: ${error.message}`, upstreamExitCode)
  }
  if (!acceptedStatuses.includes(response.status)) {
    if (credentialRejectionStatuses.has(response.status)) throw new TravelOperationalError(`Upstream rejected the travel credentials at ${url}`, credentialsExitCode)
    throw new TravelOperationalError(`Upstream request failed with status ${response.status} at ${url}`, upstreamExitCode)
  }
  try {
    return { status: response.status, body: await response.json() }
  } catch {
    throw new TravelOperationalError(`Upstream response was not JSON with status ${response.status} at ${url}`, upstreamExitCode)
  }
}

function validateQuotaState(quotaState) {
  if (!isPlainObject(quotaState)) return false
  if (Object.keys(quotaState).length !== 2) return false
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(quotaState.month)) return false
  return Number.isInteger(quotaState.count) && quotaState.count >= 0
}

async function readQuotaState(quotaFilePath, month) {
  try {
    const quotaState = await readJsonFile(quotaFilePath)
    if (!validateQuotaState(quotaState)) throw new Error('Invalid quota state')
    if (quotaState.month !== month) return { month, count: 0 }
    return quotaState
  } catch (error) {
    if (error?.code === 'ENOENT') return { month, count: 0 }
    throw error
  }
}

async function createQuotaDirectory(quotaFilePath) {
  try {
    await mkdir(dirname(quotaFilePath), { recursive: true })
  } catch {
    throw new TravelOperationalError('Travel quota state cannot be read', unreadableStateExitCode)
  }
}

async function reserveQuotaInsideLock(quotaFilePath, now) {
  try {
    const month = now.toISOString().slice(0, 7)
    const quotaState = await readQuotaState(quotaFilePath, month)
    if (quotaState.count >= serpApiMonthlyLimit) throw new TravelOperationalError('SerpApi monthly quota is spent', quotaExitCode, { quotaUsed: quotaState.count })
    const reservedQuotaState = { month, count: quotaState.count + 1 }
    await writeJsonFileAtomically(quotaFilePath, reservedQuotaState)
    return reservedQuotaState.count
  } catch (error) {
    if (error instanceof TravelOperationalError) throw error
    throw new TravelOperationalError('Travel quota state cannot be read', unreadableStateExitCode)
  }
}

async function reserveSerpApiQuota(quotaFilePath, now) {
  await createQuotaDirectory(quotaFilePath)
  try {
    return await withJsonFileLock(quotaFilePath, () => reserveQuotaInsideLock(quotaFilePath, now))
  } catch (error) {
    if (error instanceof TravelOperationalError) throw error
    throw new TravelOperationalError('Travel quota lock is busy', upstreamExitCode)
  }
}

function readFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const numberText = value.replace(/[^\d.-]/g, '')
  if (!numberText) return null
  const numericValue = Number(numberText)
  if (!Number.isFinite(numericValue)) return null
  return numericValue
}

function trimFlightLeg(flightLeg) {
  const airline = flightLeg?.airline
  const flightNumber = flightLeg?.flight_number
  const from = flightLeg?.departure_airport?.id
  const to = flightLeg?.arrival_airport?.id
  const departure = flightLeg?.departure_airport?.time
  const arrival = flightLeg?.arrival_airport?.time
  if (![airline, flightNumber, from, to, departure, arrival].every((value) => typeof value === 'string' && value)) return null
  return { airline, flight_number: flightNumber, from, to, departure, arrival }
}

function trimFlight(flight) {
  const price = readFiniteNumber(flight?.price)
  const totalDuration = readFiniteNumber(flight?.total_duration)
  if ([price, totalDuration].includes(null) || !Array.isArray(flight?.flights) || flight.flights.length === 0) return null
  const legs = flight.flights.map(trimFlightLeg).filter(Boolean)
  if (legs.length !== flight.flights.length) return null
  return { price, total_duration: totalDuration, stops: legs.length - 1, legs }
}

function trimFlights(responseBody) {
  const flightGroups = [responseBody?.best_flights, responseBody?.other_flights]
  const flights = flightGroups.flatMap((flightGroup) => Array.isArray(flightGroup) ? flightGroup : [])
  return flights.map(trimFlight).filter(Boolean).sort((firstFlight, secondFlight) => firstFlight.price - secondFlight.price).slice(0, 5)
}

function trimHotel(hotel) {
  const name = hotel?.name
  const price = hotel?.rate_per_night?.lowest
  const sortablePrice = readFiniteNumber(price)
  const rating = readFiniteNumber(hotel?.overall_rating)
  const reviewCount = readFiniteNumber(hotel?.reviews)
  if (typeof name !== 'string' || !name || [sortablePrice, rating, reviewCount].includes(null)) return null
  return { hotel: { name, price, rating, review_count: reviewCount }, sortablePrice }
}

function trimHotels(responseBody) {
  const properties = Array.isArray(responseBody?.properties) ? responseBody.properties : []
  return properties.map(trimHotel).filter(Boolean).sort((firstHotel, secondHotel) => firstHotel.sortablePrice - secondHotel.sortablePrice).slice(0, 10).map(({ hotel }) => hotel)
}

async function runSerpApiSearch(engine, searchParameters, trimResponse, { apiKey, quotaFilePath, now, fetchImplementation }) {
  const quotaUsed = await reserveSerpApiQuota(quotaFilePath, now)
  const searchUrl = new URL('https://serpapi.com/search.json')
  searchUrl.searchParams.set('engine', engine)
  Object.entries(searchParameters).forEach(([parameterName, parameterValue]) => {
    if (parameterValue === undefined) return
    searchUrl.searchParams.set(parameterName, parameterValue)
  })
  searchUrl.searchParams.set('api_key', apiKey)
  let response
  try {
    response = await fetchJson(searchUrl, { fetchImplementation })
  } catch (error) {
    error.quotaUsed = quotaUsed
    throw error
  }
  if (typeof response.body?.error === 'string') throw new TravelOperationalError(`SerpApi request failed at ${searchUrl}`, upstreamExitCode, { quotaUsed })
  const trimmedEntries = trimResponse(response.body)
  if (trimmedEntries.length === 0) throw new TravelOperationalError('No travel results found', nothingFoundExitCode, { quotaUsed })
  return { entries: trimmedEntries, quotaUsed }
}

async function searchFlights(flightInput, commandContext) {
  const apiKey = requireCredential(commandContext.credentials, 'serpApiKey', 'flights')
  const isRoundTrip = Boolean(flightInput.return)
  const { entries, quotaUsed } = await runSerpApiSearch('google_flights', {
    departure_id: flightInput.from,
    arrival_id: flightInput.to,
    outbound_date: flightInput.date,
    return_date: flightInput.return,
    type: isRoundTrip ? '1' : '2',
    currency: flightInput.currency || undefined,
  }, trimFlights, { apiKey, quotaFilePath: commandContext.quotaFilePath, now: commandContext.now, fetchImplementation: commandContext.fetchImplementation })
  const output = isRoundTrip ? { trip: 'round-trip', legs_shown: 'outbound', flights: entries } : { trip: 'one-way', flights: entries }
  return { output, quotaUsed, resultCount: entries.length }
}

async function searchHotels(hotelInput, commandContext) {
  const apiKey = requireCredential(commandContext.credentials, 'serpApiKey', 'hotels')
  const { entries, quotaUsed } = await runSerpApiSearch('google_hotels', {
    q: hotelInput.query,
    check_in_date: hotelInput.checkIn,
    check_out_date: hotelInput.checkOut,
    max_price: hotelInput.maxPrice || undefined,
    adults: hotelInput.adults || undefined,
    currency: hotelInput.currency || undefined,
  }, trimHotels, { apiKey, quotaFilePath: commandContext.quotaFilePath, now: commandContext.now, fetchImplementation: commandContext.fetchImplementation })
  return { output: { hotels: entries }, quotaUsed, resultCount: entries.length }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function trimListedPrice(shoppingResult) {
  const title = shoppingResult?.title
  const seller = shoppingResult?.source
  const price = shoppingResult?.price
  const priceValue = readFiniteNumber(shoppingResult?.extracted_price)
  if (![title, seller, price].every(isNonEmptyString) || priceValue === null) return null
  const optionalFields = {
    wasPrice: shoppingResult.old_price,
    discount: shoppingResult.tag,
    condition: shoppingResult.second_hand_condition,
    delivery: shoppingResult.delivery,
    rating: readFiniteNumber(shoppingResult.rating),
    reviews: readFiniteNumber(shoppingResult.reviews),
  }
  const statedOptionalFields = Object.entries(optionalFields).filter(([, fieldValue]) => isNonEmptyString(fieldValue) || typeof fieldValue === 'number')
  return { title, seller, price, priceValue, ...Object.fromEntries(statedOptionalFields), hasOtherSellers: shoppingResult.multiple_sources === true }
}

function trimListedPrices(responseBody) {
  const shoppingResults = Array.isArray(responseBody?.shopping_results) ? responseBody.shopping_results : []
  return shoppingResults.map(trimListedPrice).filter(Boolean).slice(0, maxListedPrices)
}

async function searchPrices(priceInput, commandContext) {
  const apiKey = requireCredential(commandContext.credentials, 'serpApiKey', 'prices')
  const { entries, quotaUsed } = await runSerpApiSearch('google_shopping', {
    q: priceInput.query,
    gl: (priceInput.country || 'us').toLowerCase(),
    hl: 'en',
  }, trimListedPrices, { apiKey, quotaFilePath: commandContext.quotaFilePath, now: commandContext.now, fetchImplementation: commandContext.fetchImplementation })
  return { output: { prices: entries }, quotaUsed, resultCount: entries.length }
}

function optionalString(value) {
  return typeof value === 'string' ? value : null
}

function trimFlightStatus(segment) {
  const flight = segment?.ident
  const from = segment?.origin?.code_iata
  const to = segment?.destination?.code_iata
  if (![flight, from, to].every((value) => typeof value === 'string' && value)) return null
  const status = optionalString(segment?.status)
  const scheduledOut = optionalString(segment?.scheduled_out)
  const estimatedOut = optionalString(segment?.estimated_out)
  const scheduledIn = optionalString(segment?.scheduled_in)
  const estimatedIn = optionalString(segment?.estimated_in)
  const gateOrigin = optionalString(segment?.gate_origin)
  const terminalOrigin = optionalString(segment?.terminal_origin)
  const gateDestination = optionalString(segment?.gate_destination)
  const terminalDestination = optionalString(segment?.terminal_destination)
  const arrivalDelayMinutes = typeof segment?.arrival_delay === 'number' && Number.isFinite(segment.arrival_delay) ? Math.round(segment.arrival_delay / 60) : null
  const cancelled = typeof segment?.cancelled === 'boolean' ? segment.cancelled : null
  return {
    flight,
    from,
    to,
    status,
    scheduled_out: scheduledOut,
    estimated_out: estimatedOut,
    scheduled_in: scheduledIn,
    estimated_in: estimatedIn,
    gate_origin: gateOrigin,
    terminal_origin: terminalOrigin,
    gate_destination: gateDestination,
    terminal_destination: terminalDestination,
    arrival_delay_minutes: arrivalDelayMinutes,
    cancelled,
  }
}

async function searchFlightStatus(travelInput, credentials, fetchImplementation) {
  const apiKey = requireCredential(credentials, 'aeroApiKey', 'status')
  const flightStatusUrl = new URL(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(travelInput.flight)}`)
  flightStatusUrl.searchParams.set('ident_type', 'designator')
  flightStatusUrl.searchParams.set('start', travelInput.date)
  flightStatusUrl.searchParams.set('end', new Date(Date.parse(`${travelInput.date}T00:00:00.000Z`) + millisecondsPerDay).toISOString().slice(0, 10))
  const { status, body } = await fetchJson(flightStatusUrl, { headers: { 'x-apikey': apiKey }, acceptedStatuses: [200, 400], fetchImplementation })
  if (status === 400) throw new TravelUsageError('Flight status request was rejected')
  const flights = (Array.isArray(body?.flights) ? body.flights : []).map(trimFlightStatus).filter(Boolean).slice(0, 3)
  if (flights.length === 0) throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  return { output: { flights }, quotaUsed: 0, resultCount: flights.length }
}

function matchCoordinatePair(placeText) {
  return /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(placeText)
}

function isCoordinatePair(placeText) {
  return matchCoordinatePair(placeText) !== null
}

function parseCoordinatePoint(placeText) {
  const coordinateMatch = matchCoordinatePair(placeText)
  if (!coordinateMatch) return null
  const latitude = Number(coordinateMatch[1])
  const longitude = Number(coordinateMatch[2])
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new TravelUsageError('Route coordinates are invalid')
  return { coordinates: [longitude, latitude], label: placeText }
}

function toOrsPoint(coordinates) {
  return `${coordinates[0]},${coordinates[1]}`
}

async function geocodePlace(placeText, country, requestOptions) {
  const coordinatePoint = parseCoordinatePoint(placeText)
  if (coordinatePoint) return coordinatePoint
  const geocodeUrl = new URL('https://api.heigit.org/pelias/v1/search')
  geocodeUrl.searchParams.set('text', placeText)
  if (country) geocodeUrl.searchParams.set('boundary.country', country)
  const { body } = await fetchJson(geocodeUrl, requestOptions)
  const firstFeature = Array.isArray(body?.features) ? body.features[0] : null
  const coordinates = firstFeature?.geometry?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.slice(0, 2).some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  }
  const [longitude, latitude] = coordinates
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  const label = typeof firstFeature?.properties?.label === 'string' && firstFeature.properties.label ? firstFeature.properties.label : placeText
  return { coordinates: [longitude, latitude], label }
}

async function searchRoute(routeInput, commandContext) {
  const apiKey = requireCredential(commandContext.credentials, 'orsApiKey', 'route')
  const requestOptions = { headers: { Authorization: apiKey }, fetchImplementation: commandContext.fetchImplementation }
  const fromPoint = await geocodePlace(routeInput.from, routeInput.country, requestOptions)
  const toPoint = await geocodePlace(routeInput.to, routeInput.country, requestOptions)
  const directionsUrl = new URL(`https://api.heigit.org/openrouteservice/v2/directions/${routeInput.profile}`)
  directionsUrl.searchParams.set('start', toOrsPoint(fromPoint.coordinates))
  directionsUrl.searchParams.set('end', toOrsPoint(toPoint.coordinates))
  const { status, body } = await fetchJson(directionsUrl, { ...requestOptions, acceptedStatuses: [200, 404] })
  if (status === 404 && body?.error?.code === 2009) throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  if (status !== 200) throw new TravelOperationalError(`Upstream request failed with status ${status} at ${directionsUrl}`, upstreamExitCode)
  const summary = Array.isArray(body?.features) ? body.features[0]?.properties?.summary : null
  const distanceMeters = readFiniteNumber(summary?.distance)
  const durationSeconds = readFiniteNumber(summary?.duration)
  if ([distanceMeters, durationSeconds].includes(null)) throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  return {
    output: {
      distance_km: distanceMeters / 1_000,
      duration_minutes: durationSeconds / 60,
      profile: routeInput.profile,
      from: fromPoint.label,
      to: toPoint.label,
    },
    quotaUsed: 0,
    resultCount: 1,
  }
}

function trimJourneyLeg(journeyLeg) {
  const mode = journeyLeg?.mode?.name
  const line = journeyLeg?.routeOptions?.[0]?.name
  const from = journeyLeg?.departurePoint?.commonName
  const to = journeyLeg?.arrivalPoint?.commonName
  const departure = journeyLeg?.departureTime
  if (![mode, from, to, departure].every((value) => typeof value === 'string' && value)) return null
  return { mode, line: typeof line === 'string' && line ? line : null, from, to, departure }
}

function trimJourney(journey) {
  const duration = readFiniteNumber(journey?.duration)
  if (duration === null || !Array.isArray(journey?.legs) || journey.legs.length === 0) return null
  const legs = journey.legs.map(trimJourneyLeg).filter(Boolean)
  if (legs.length !== journey.legs.length) return null
  return { duration, legs }
}

function trimJourneys(responseBody) {
  const journeys = Array.isArray(responseBody?.journeys) ? responseBody.journeys : []
  return journeys.map(trimJourney).filter(Boolean).slice(0, 3)
}

function trimDisambiguationOptions(responseBody) {
  const disambiguations = [
    ['from', responseBody?.fromLocationDisambiguation?.disambiguationOptions],
    ['to', responseBody?.toLocationDisambiguation?.disambiguationOptions],
  ]
  for (const [field, untrimmedOptions] of disambiguations) {
    if (!Array.isArray(untrimmedOptions)) continue
    const options = untrimmedOptions.flatMap((option) => {
      const label = option?.place?.commonName
      if (typeof label !== 'string' || !label) return []
      const id = option?.place?.icsCode
      return [{ label, id: typeof id === 'string' && id ? id : null }]
    }).slice(0, 5)
    if (options.length > 0) return { field, options }
  }
  return null
}

async function searchJourney(journeyInput, commandContext) {
  const journeyUrl = new URL(`https://api.tfl.gov.uk/Journey/JourneyResults/${encodeURIComponent(journeyInput.from)}/to/${encodeURIComponent(journeyInput.to)}`)
  if (commandContext.credentials.tflAppKey?.trim()) journeyUrl.searchParams.set('app_key', commandContext.credentials.tflAppKey.trim())
  const { status, body } = await fetchJson(journeyUrl, { acceptedStatuses: [200, 300], fetchImplementation: commandContext.fetchImplementation })
  if (status === 300) {
    const ambiguous = trimDisambiguationOptions(body)
    if (!ambiguous) throw new TravelOperationalError('TfL returned an ambiguous place without options', upstreamExitCode)
    return { output: { ambiguous }, quotaUsed: 0, resultCount: ambiguous.options.length, exitCode: ambiguousExitCode }
  }
  const journeys = trimJourneys(body)
  if (journeys.length === 0) throw new TravelOperationalError('No travel results found', nothingFoundExitCode)
  return { output: { journeys }, quotaUsed: 0, resultCount: journeys.length }
}

function createMapLink(mapLinkInput) {
  const encodedStops = mapLinkInput.stops.map((stop) => encodeURIComponent(stop).replaceAll('(', '%28').replaceAll(')', '%29'))
  const label = mapLinkInput.label || defaultMapLinkLabel(mapLinkInput.stops, mapLinkInput.mode)
  // Path form, not the documented /maps/dir/?api=1: some link rewriters strip the slash before "?" and Google 404s on the result.
  const url = `https://www.google.com/maps/dir/${encodedStops.join('/')}/data=!4m2!4m1!3e${mapLinkModeDigits.get(mapLinkInput.mode)}?travelmode=${mapLinkInput.mode}`
  return {
    output: { url, telegramLink: `[${escapeReservedCharacters(label)}](${url})`, label, mode: mapLinkInput.mode, stops: mapLinkInput.stops },
    quotaUsed: 0,
    resultCount: 1,
  }
}

function defaultMapLinkLabel(stops, mode) {
  const modeLabel = `${mode[0].toUpperCase()}${mode.slice(1)}`
  const stopLabels = stops.map((stop) => {
    if (isCoordinatePair(stop)) return stop
    return stop.split(',', 1)[0].trim()
  })
  return `${modeLabel} route: ${stopLabels.join(' → ')}`
}

async function executeTravelCommand(command, travelInput, commandContext) {
  if (command === 'flights') return searchFlights(travelInput, commandContext)
  if (command === 'hotels') return searchHotels(travelInput, commandContext)
  if (command === 'status') return searchFlightStatus(travelInput, commandContext.credentials, commandContext.fetchImplementation)
  if (command === 'route') return searchRoute(travelInput, commandContext)
  if (command === 'maplink') return createMapLink(travelInput)
  if (command === 'prices') return searchPrices(travelInput, commandContext)
  return searchJourney(travelInput, commandContext)
}

function writeTravelLog(command, status, quotaUsed, resultCount) {
  const loggedCommand = Object.hasOwn(commandInputFields, command) ? command : 'unknown'
  logEvent('travel', 'query', { command: loggedCommand, status, quota_used: quotaUsed, result_count: resultCount })
}

export async function runTravelCommand(commandArguments, {
  envFilePath = getTravelEnvironmentFilePath(),
  quotaFilePath = getTravelQuotaFilePath(),
  now = new Date(),
  fetchImplementation = fetch,
  writeOutput = console.log,
  writeError = console.error,
  readStandardInput = readProcessStandardInput,
} = {}) {
  const [command, ...argumentsToParse] = commandArguments
  let secretValues = []
  try {
    if (!Object.hasOwn(commandInputFields, command)) throw new TravelUsageError('Unknown command')
    if (argumentsToParse.length !== 1 || argumentsToParse[0] !== '--stdin') throw new TravelUsageError(`usage: travel.mjs ${command} --stdin < input.json`)
    const travelInput = validateCommandInput(command, await readTravelInput(command, readStandardInput), now)
    const credentials = command === 'maplink' ? {} : await loadTravelCredentials(envFilePath)
    secretValues = Object.values(credentials).filter((credential) => typeof credential === 'string' && credential)
    const commandResult = await executeTravelCommand(command, travelInput, { credentials, quotaFilePath, now, fetchImplementation })
    const commandExitCode = commandResult.exitCode ?? 0
    writeOutput(JSON.stringify(commandResult.output))
    writeTravelLog(command, commandExitCode, commandResult.quotaUsed, commandResult.resultCount)
    return commandExitCode
  } catch (error) {
    if (error instanceof TravelUsageError) {
      writeError(redactUrl(error.message, secretValues))
      writeTravelLog(command, usageExitCode, 0, 0)
      return usageExitCode
    }
    if (error instanceof TravelOperationalError) {
      if (error.message) writeError(redactUrl(error.message, secretValues))
      writeTravelLog(command, error.exitCode, error.quotaUsed || 0, 0)
      return error.exitCode
    }
    throw error
  }
}

if (isMainModule(import.meta.url)) {
  runCommandLine(runTravelCommand, { writeError: (message) => console.error(redactUrl(message)) })
}
