import MockDate from 'mockdate'
import moment from 'moment'
import dayjs from 'dayjs'
import toArray from 'dayjs/plugin/toArray'

dayjs.extend(toArray)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('As Array -> toArray', () => {
  expect(dayjs().toArray()).toEqual(moment().toArray())
})
