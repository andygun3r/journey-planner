import ActivityKit
import Foundation

public struct JourneyActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var status: String
        public var currentStop: String
        public var nextStop: String
        public var eta: Date
        public var delayMinutes: Int?

        public init(status: String, currentStop: String, nextStop: String, eta: Date, delayMinutes: Int?) {
            self.status = status
            self.currentStop = currentStop
            self.nextStop = nextStop
            self.eta = eta
            self.delayMinutes = delayMinutes
        }
    }

    public var routeName: String
    public var trainUID: String?

    public init(routeName: String, trainUID: String?) {
        self.routeName = routeName
        self.trainUID = trainUID
    }
}
