import Foundation

/// Chat time dividers, the Messages way (owner, 2026-11-11): a centred, small,
/// secondary-color line above a message when it is the first one shown, or when
/// more than `gap` (about 15 minutes) passed since the message before it; never a
/// time on every message. The dates are the SERVER's (`timestamp` / snapshot `at`,
/// ChatMessage.serverDate); a live game line carries none and is stamped on receipt.
enum ChatTimestamps {
    /// More than this since the previous message starts a new divider.
    static let gap: TimeInterval = 15 * 60

    /// The indices of `dates` that get a divider above them.
    static func dividerIndices(_ dates: [Date], gap: TimeInterval = gap) -> Set<Int> {
        var out = Set<Int>()
        for (i, date) in dates.enumerated() {
            if i == 0 || date.timeIntervalSince(dates[i - 1]) > gap { out.insert(i) }
        }
        return out
    }

    /// "Today 2:14 PM", "Yesterday 9:03 PM", a weekday within the last 7 days
    /// ("Mon 4:10 PM"), else a date ("Nov 3, 4:10 PM"; with the year when it is not
    /// this year). The time follows the locale and the device's 12/24-hour setting
    /// (`Locale.autoupdatingCurrent` carries it; tests pass "@hours=h23").
    static func label(for date: Date, now: Date = Date(), locale: Locale = .autoupdatingCurrent,
                      calendar baseCalendar: Calendar = .autoupdatingCurrent) -> String {
        var calendar = baseCalendar
        calendar.locale = locale
        let time = format(date, template: "jmm", locale: locale, calendar: calendar)
        switch dayKind(date, now: now, calendar: calendar) {
        case .today, .yesterday:
            return "\(relativeDay(date, locale: locale, calendar: calendar)) \(time)"
        case .thisWeek:
            return "\(format(date, template: "EEE", locale: locale, calendar: calendar)) \(time)"
        case .older(let sameYear):
            let day = format(date, template: sameYear ? "MMMd" : "yMMMd", locale: locale, calendar: calendar)
            return "\(day), \(time)"
        }
    }

    /// What VoiceOver reads: the full form ("Today at 2:14 PM", "Monday, November 3 at 4:10 PM").
    static func spokenLabel(for date: Date, now: Date = Date(), locale: Locale = .autoupdatingCurrent,
                            calendar baseCalendar: Calendar = .autoupdatingCurrent) -> String {
        var calendar = baseCalendar
        calendar.locale = locale
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.doesRelativeDateFormatting = true
        f.timeStyle = .short
        switch dayKind(date, now: now, calendar: calendar) {
        case .today, .yesterday:
            f.dateStyle = .long
            return f.string(from: date)
        case .thisWeek, .older:
            f.doesRelativeDateFormatting = false
            f.dateStyle = .full
            return f.string(from: date)
        }
    }

    enum DayKind: Equatable { case today, yesterday, thisWeek, older(sameYear: Bool) }

    static func dayKind(_ date: Date, now: Date, calendar: Calendar) -> DayKind {
        let day = calendar.startOfDay(for: date), today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        switch days {
        case ...0: return .today          // a clock a little ahead of the server reads as today
        case 1: return .yesterday
        case 2...6: return .thisWeek
        default: return .older(sameYear: calendar.component(.year, from: date) == calendar.component(.year, from: now))
        }
    }

    private static func relativeDay(_ date: Date, locale: Locale, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.doesRelativeDateFormatting = true
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: date)
    }

    private static func format(_ date: Date, template: String, locale: Locale, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate(template)
        return f.string(from: date)
    }
}
