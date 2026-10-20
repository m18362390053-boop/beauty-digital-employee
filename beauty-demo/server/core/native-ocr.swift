import Foundation
import Vision

guard CommandLine.arguments.count == 2 else { exit(2) }
let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.automaticallyDetectsLanguage = true

do {
    try VNImageRequestHandler(url: imageURL).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> [String: Any]? in
        guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return ["text": text, "y": observation.boundingBox.midY]
    }.sorted { ($0["y"] as? Double ?? 0) > ($1["y"] as? Double ?? 0) }
    let output = lines.map { $0["text"] as? String ?? "" }
    let data = try JSONSerialization.data(withJSONObject: output)
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data(String(describing: error).utf8))
    exit(1)
}
