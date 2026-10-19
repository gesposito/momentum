import MockDate from 'mockdate'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/ru'
import locale from 'dayjs/locale/ar-kw'

dayjs.extend(relativeTime)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('Meridiem', () => {
  dayjs.locale(locale)
  expect(dayjs('2020-01-01 03:00:00').locale('ar-kw').format('A')).toEqual('ص')
  expect(dayjs('2020-01-01 11:00:00').locale('ar-kw').format('A')).toEqual('ص')
  expect(dayjs('2020-01-01 16:00:00').locale('ar-kw').format('A')).toEqual('م')
  expect(dayjs('2020-01-01 20:00:00').locale('ar-kw').format('A')).toEqual('م')
})
