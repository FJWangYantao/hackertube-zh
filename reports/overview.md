# HackerTube 数据概览

由 `tools/summarize.py` 生成，数据导出日期 2026-10-31。

## 完整性校验

| 项目 | 值 |
| --- | --- |
| videos.jsonl 行数 | 6,454 |
| mentions.jsonl 行数 | 39,834 |
| vid 唯一 | 6,454 / 6,454 |
| 有评论记录的视频 | 6,454 / 6,454 |
| 只有引用、无推荐的视频 | 1,658 |
| related.jsonl 条数 | 3,778 |
| 疑似重复标题 | 24 组 |

## 内容类型

| content_type | 数量 | 占比 |
| --- | ---: | ---: |
| talk | 1,448 | 22.4% |
| explainer | 1,091 | 16.9% |
| demo | 827 | 12.8% |
| comedy | 567 | 8.8% |
| commentary | 457 | 7.1% |
| documentary | 404 | 6.3% |
| interview | 342 | 5.3% |
| lecture | 317 | 4.9% |
| other | 282 | 4.4% |
| news | 239 | 3.7% |
| music | 187 | 2.9% |
| tutorial | 176 | 2.7% |
| podcast | 93 | 1.4% |
| course | 24 | 0.4% |

## 难度

| level | 数量 | 占比 |
| --- | ---: | ---: |
| general | 4,588 | 71.1% |
| intermediate | 1,168 | 18.1% |
| intro | 398 | 6.2% |
| advanced | 300 | 4.6% |

## 时效性

| shelf_life | 数量 | 占比 |
| --- | ---: | ---: |
| evergreen | 4,546 | 70.4% |
| dated | 1,501 | 23.3% |
| news | 407 | 6.3% |

## 评论立场（39,834 条评论）

| stance | 数量 | 占比 |
| --- | ---: | ---: |
| reference | 19,148 | 48.1% |
| rec | 12,141 | 30.5% |
| strong_rec | 4,043 | 10.1% |
| joke | 2,711 | 6.8% |
| critical | 1,791 | 4.5% |

## 领域（一个视频可计入多个领域）

| area_name | 数量 | 占比 |
| --- | ---: | ---: |
| Arts, Comedy, Music & Film | 1,731 | 26.8% |
| Software Engineering & Languages | 1,604 | 24.9% |
| Politics, History & Society | 1,425 | 22.1% |
| Computing History & Culture | 1,295 | 20.1% |
| Engineering, Transport & Making | 994 | 15.4% |
| Systems, Networks & Security | 956 | 14.8% |
| Life Sciences, Mind & Health | 827 | 12.8% |
| Business, Startups & Economics | 787 | 12.2% |
| Ideas, Learning & Language | 782 | 12.1% |
| Hardware & Electronics | 769 | 11.9% |
| Physics, Space & Chemistry | 768 | 11.9% |
| AI, Machine Learning & Data | 718 | 11.1% |
| Games & Game Development | 503 | 7.8% |
| Design, Graphics & Visual Media | 501 | 7.8% |
| Mathematics & Theoretical CS | 479 | 7.4% |
| Earth, Energy & Environment | 448 | 6.9% |

## Top 15 主题

| category | 数量 | 占比 |
| --- | ---: | ---: |
| Tech pioneers & interviews | 369 | 5.7% |
| Satire & parody | 362 | 5.6% |
| Media, journalism & propaganda | 334 | 5.2% |
| Film & TV clips | 310 | 4.8% |
| Stand-up & sketch comedy | 244 | 3.8% |
| Music performance & songs | 239 | 3.7% |
| History of computing | 231 | 3.6% |
| Functional programming | 225 | 3.5% |
| Tech company stories & documentaries | 204 | 3.2% |
| Documentaries & storytelling | 202 | 3.1% |
| Consumer devices & gadgets | 199 | 3.1% |
| Programming language design | 193 | 3.0% |
| Security & hacking | 192 | 3.0% |
| Law, policing & justice | 188 | 2.9% |
| US politics & elections | 187 | 2.9% |

## Top 15 频道

| channel | 数量 | 占比 |
| --- | ---: | ---: |
| TED | 96 | 1.5% |
| Veritasium | 92 | 1.4% |
| LastWeekTonight | 68 | 1.1% |
| Tom Scott | 60 | 0.9% |
| Google TechTalks | 56 | 0.9% |
| Technology Connections | 55 | 0.9% |
| CGP Grey | 50 | 0.8% |
| Kurzgesagt – In a Nutshell | 50 | 0.8% |
| TEDx Talks | 49 | 0.8% |
| CppCon | 48 | 0.7% |
| Lex Fridman | 48 | 0.7% |
| Strange Loop Conference | 46 | 0.7% |
| Not Just Bikes | 46 | 0.7% |
| 3Blue1Brown | 43 | 0.7% |
| Talks at Google | 41 | 0.6% |

## 评论年份分布

| 年份 | 评论数 |
| --- | ---: |
| 2007 | 12 |
| 2008 | 32 |
| 2009 | 116 |
| 2010 | 264 |
| 2011 | 436 |
| 2012 | 602 |
| 2013 | 872 |
| 2014 | 1,092 |
| 2015 | 1,389 |
| 2016 | 1,958 |
| 2017 | 2,180 |
| 2018 | 2,617 |
| 2019 | 2,923 |
| 2020 | 3,949 |
| 2021 | 4,669 |
| 2022 | 4,667 |
| 2023 | 4,579 |
| 2024 | 3,139 |
| 2025 | 2,796 |
| 2026 | 1,542 |

## 分数最高的 25 个视频

| # | 视频 | 频道 | 分数 | 推荐月数 | 类型 |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | [Vectors \| Chapter 1, Essence of linear algebra](https://www.youtube.com/watch?v=fNk_zzaMoSs) | 3Blue1Brown | 25.0 | 18 | course |
| 2 | [Ruby Conf 12 - Y Not- Adventures in Functional Programming by Jim W...](https://www.youtube.com/watch?v=FITJMJjASUs) | Confreaks | 22.5 | 18 | talk |
| 3 | [Indistinguishable From Magic: Manufacturing Modern Computer Chips](https://www.youtube.com/watch?v=NGFhc8R_uO4) | Andor Gafotas | 22.0 | 18 | talk |
| 4 | [How to Speak](https://www.youtube.com/watch?v=Unzc731iCUY) | MIT OpenCourseWare | 21.0 | 16 | lecture |
| 5 | [The spelled-out intro to neural networks and backpropagation: build...](https://www.youtube.com/watch?v=VMj-3S1tku0) | Andrej Karpathy | 21.0 | 16 | lecture |
| 6 | [8 Bit & '8 Bitish' Graphics-Outside the Box](https://www.youtube.com/watch?v=aMcJ1Jvtef0) | GDC Festival of Gaming | 20.0 | 17 | talk |
| 7 | [How Python was Shaped by leaky Internals, Armin Ronacher, Flask fra...](https://www.youtube.com/watch?v=qCGofLIzX6g) | Видео с мероприятий {speach! | 19.5 | 16 | talk |
| 8 | [AT&T Archives: Similiarities of Wave Behavior (Bonus Edition)](https://www.youtube.com/watch?v=DovunOxlY1k) | AT&T Tech Channel | 19.0 | 15 | lecture |
| 9 | [In Search Of A Flat Earth](https://www.youtube.com/watch?v=JTfhYyTuT44) | Folding Ideas | 19.0 | 15 | documentary |
| 10 | [1. Introduction to Human Behavioral Biology](https://www.youtube.com/watch?v=NNnIGh9g6fA) | Stanford | 19.0 | 15 | lecture |
| 11 | [How The Economic Machine Works by Ray Dalio](https://www.youtube.com/watch?v=PHe0bXAIuk0) | Principles by Ray Dalio | 19.0 | 17 | explainer |
| 12 | [RailsConf 2014 - All the Little Things by Sandi Metz](https://www.youtube.com/watch?v=8bZh5LMaSmE) | Confreaks | 18.5 | 15 | talk |
| 13 | [But what is the Fourier Transform?  A visual introduction.](https://www.youtube.com/watch?v=spUNpyF58BY) | 3Blue1Brown | 18.5 | 15 | explainer |
| 14 | [Around The Corner - How Differential Steering Works (1937)](https://www.youtube.com/watch?v=yYAw79386WI) | US Auto Industry | 18.5 | 15 | explainer |
| 15 | [The Soul of Erlang and Elixir • Sasa Juric • GOTO 2019](https://www.youtube.com/watch?v=JvBT4XBdoUE) | GOTO Conferences | 17.5 | 14 | talk |
| 16 | [Essential Ideas for Parents](https://www.youtube.com/watch?v=SCAGc-rkIfo) | Jason Salotti | 17.0 | 13 | lecture |
| 17 | ["Simple Made Easy" - Rich Hickey (2011)](https://www.youtube.com/watch?v=SxdOUGdseq4) | Strange Loop Conference | 17.0 | 14 | talk |
| 18 | [The Quantum Conspiracy: What Popularizers of QM Don't Want You to Know](https://www.youtube.com/watch?v=dEaecUuEqfc) | Google TechTalks | 17.0 | 15 | talk |
| 19 | [Try to Rule Fairly and You'll Be Overthrown](https://www.youtube.com/watch?v=rStL7niR7gs) | CGP Grey | 17.0 | 15 | explainer |
| 20 | [LEADERSHIP LAB: The Craft of Writing Effectively](https://www.youtube.com/watch?v=vtIzMaLkCaM) | UChicago Social Sciences | 17.0 | 14 | lecture |
| 21 | [What the heck is the event loop anyway? \| Philip Roberts \| JSConf EU](https://www.youtube.com/watch?v=8aGhZQkoFbQ) | JSConf | 16.5 | 14 | talk |
| 22 | [But what is a neural network? \| Deep learning chapter 1](https://www.youtube.com/watch?v=aircAruvnKk) | 3Blue1Brown | 16.5 | 14 | explainer |
| 23 | [A Better Default Colormap for Matplotlib \| SciPy 2015 \| Nathaniel...](https://www.youtube.com/watch?v=xAoljeRJ3lU) | Enthought | 16.5 | 14 | talk |
| 24 | [George Lakoff: Moral Politics](https://www.youtube.com/watch?v=5f9R9MtkpqM) | University of California Television (UCTV) | 16.0 | 12 | lecture |
| 25 | [Heat Pumps: the Future of Home Heating](https://www.youtube.com/watch?v=7J52mDjZzto) | Technology Connections | 16.0 | 15 | explainer |

---

数据来源：[HackerTube](https://hackertube.org)（ODC-By 1.0），评论来自
[open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) 数据集。
分类、摘要与立场标注由 LLM 生成，存在少量误差。
