import MockDate from 'mockdate'
import moment from 'moment'
import dayjs from 'dayjs'
import arraySupport from 'dayjs/plugin/arraySupport'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)
dayjs.extend(arraySupport)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

describe('parse empty array', () => {
  it('local', () => {
    expect(dayjs([]).format())
      .toBe(moment([]).format())
  })
  it('utc', () => {
    expect(dayjs.utc([]).format())
      .toBe(moment.utc([]).format())
  })
})

const testArrs = [
  [2010, 1, 14, 15, 25, 50, 125],
  [2010],
  [2010, 6],
  [2010, 6, 10]
]

describe('parse array local', () => {
  testArrs.forEach((testArr) => {
    it(String(testArr), () => {
      expect(dayjs(testArr).format())
        .toBe(moment(testArr).format())
    })
  })
})

describe('parse array utc', () => {
  testArrs.forEach((testArr) => {
    it(String(testArr), () => {
      expect(dayjs.utc(testArr).format())
        .toBe(moment.utc(testArr).format())
    })
  })
})
