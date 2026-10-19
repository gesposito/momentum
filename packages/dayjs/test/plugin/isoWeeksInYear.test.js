import MockDate from 'mockdate'
import dayjs from 'dayjs'
import isoWeeksInYear from 'dayjs/plugin/isoWeeksInYear'
import isLeapYear from 'dayjs/plugin/isLeapYear'

dayjs.extend(isoWeeksInYear)
dayjs.extend(isLeapYear)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('isoWeeksInYear', () => {
  expect(dayjs('2004').isoWeeksInYear()).toBe(53)
  expect(dayjs('2005').isoWeeksInYear()).toBe(52)
  expect(dayjs('2006').isoWeeksInYear()).toBe(52)
  expect(dayjs('2007').isoWeeksInYear()).toBe(52)
  expect(dayjs('2008').isoWeeksInYear()).toBe(52)
  expect(dayjs('2009').isoWeeksInYear()).toBe(53)
  expect(dayjs('2010').isoWeeksInYear()).toBe(52)
  expect(dayjs('2011').isoWeeksInYear()).toBe(52)
  expect(dayjs('2012').isoWeeksInYear()).toBe(52)
  expect(dayjs('2013').isoWeeksInYear()).toBe(52)
  expect(dayjs('2014').isoWeeksInYear()).toBe(52)
  expect(dayjs('2015').isoWeeksInYear()).toBe(53)
})
