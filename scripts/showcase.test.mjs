import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { findBriefViolations } from './brief-check.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const showcaseDirectory = resolveRepositoryPath('showcase')
const postsText = readFileSync(join(showcaseDirectory, 'posts.md'), 'utf8')
const shortenedLinkLength = 23
const imageMarkerPattern = /\s*\[(img\/[^\]]+)\]/g

function readPostSection(heading) {
  const sectionStart = postsText.indexOf(`## ${heading}\n`)
  assert.notEqual(sectionStart, -1, `posts.md lacks a ${heading} section`)
  const sectionBody = postsText.slice(sectionStart + heading.length + 4)
  const nextHeadingIndex = sectionBody.indexOf('\n## ')
  return (nextHeadingIndex === -1 ? sectionBody : sectionBody.slice(0, nextHeadingIndex)).trim()
}

function measurePostLength(postText) {
  return postText.replace(imageMarkerPattern, '').replace('REPO_URL', 'x'.repeat(shortenedLinkLength)).length
}

function readShowcaseTextFiles() {
  const mockFileNames = readdirSync(join(showcaseDirectory, 'mocks')).map((fileName) => join('mocks', fileName))
  return ['posts.md', 'brief.mock.md', ...mockFileNames].map((relativePath) => ({
    relativePath,
    fileText: readFileSync(join(showcaseDirectory, relativePath), 'utf8'),
  }))
}

test('every tweet in the X thread fits in 280 characters', () => {
  const tweets = readPostSection('X thread').split('\n\n')
  tweets.forEach((tweet) => assert.ok(measurePostLength(tweet) <= 280, `${measurePostLength(tweet)} characters: ${tweet}`))
})

test('the Bluesky post fits in 300 characters', () => {
  assert.ok(measurePostLength(readPostSection('Bluesky')) <= 300)
})

test('the Show HN title fits in 80 characters', () => {
  const titleLine = readPostSection('Show HN').split('\n').find((line) => line.startsWith('Title: '))
  assert.ok(titleLine.length - 'Title: '.length <= 80)
})

test('every image a post names has been rendered from a mock page', () => {
  const imagePaths = [...postsText.matchAll(imageMarkerPattern)].map((match) => match[1])
  assert.ok(imagePaths.length > 0)
  imagePaths.forEach((imagePath) => {
    const mockName = imagePath.replace(/^img\//, '').replace(/\.png$/, '')
    assert.ok(existsSync(join(showcaseDirectory, imagePath)), `${imagePath} missing; run node showcase/render.mjs`)
    assert.ok(existsSync(join(showcaseDirectory, 'mocks', `${mockName}.html`)), `${mockName}.html missing`)
  })
})

test('showcase files carry only invented addresses on reserved example domains', () => {
  const emailPattern = /[\w.+-]+@([\w-]+\.)+[a-z]{2,}/gi
  const reservedDomainPattern = /@(example\.(com|net|org)|([\w-]+\.)+(test|example))$/i
  readShowcaseTextFiles().forEach(({ relativePath, fileText }) => {
    const realLookingAddresses = (fileText.match(emailPattern) ?? []).filter((address) => !reservedDomainPattern.test(address))
    assert.deepEqual(realLookingAddresses, [], `${relativePath} carries a non-example address`)
  })
})

test('showcase files never name the operator by first name', () => {
  readShowcaseTextFiles().forEach(({ relativePath, fileText }) => {
    assert.doesNotMatch(fileText, /\bJohn\b/, `${relativePath} names the operator`)
  })
})

test('the mock brief passes the same check a live brief must pass', () => {
  const briefPath = join(showcaseDirectory, 'brief.mock.md')
  assert.deepEqual(findBriefViolations(readFileSync(briefPath, 'utf8'), { filePath: briefPath }), [])
})
